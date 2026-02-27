console.log("Bot started");
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, Message, TextChannel } from "discord.js";
import { storage } from "./storage";

interface GameState {
  guildId: string;
  hostId: string;
  channelId: string;
  requiredPlayers: number;
  players: string[]; // user IDs
  alivePlayers: string[];
  imposters: string[];
  roles: Record<string, "imposter" | "citizen">;
  votes: Record<string, string>;
  phase: "lobby" | "discussion" | "voting" | "revote";
  day: number;
  discussionTimer?: NodeJS.Timeout;
  votingTimer?: NodeJS.Timeout;
  voteMessageId?: string;
  discussionMessageId?: string;
  lockedChannelPermissions?: any; // To restore later
  tiedPlayers?: string[]; // For revotes
}

const games: Record<string, GameState> = {};
let client: Client;

export async function setupBot() {
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers
    ],
  });

  client.on("ready", () => {
    console.log(`Bot logged in as ${client.user?.tag}`);
  });

  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    const args = message.content.trim().split(/ +/);
    const command = args[0].toLowerCase();

    if (command === "!start") {
      const embed = new EmbedBuilder()
        .setTitle("Xarunta Ciyaarta")
        .setDescription("Ku soo dhawoow Xarunta Ciyaarta!\n\nCiyaaraha la heli karo:\n• FTI (Raadi imposterka)\n\nQor `!fti` si aad u bilowdo ciyaarta.")
        .setColor("#0099ff");
      await message.channel.send({ embeds: [embed] });
    }

    if (command === "!stats") {
      const stats = await storage.getUserStats(message.author.id);
      if (!stats) {
        return message.reply("Wali wax ciyaar ah ma aadan dheelin!");
      }
      const embed = new EmbedBuilder()
        .setTitle(`Xogta ${stats.displayName}`)
        .addFields(
          { name: "Ciyaaraha la dheelay", value: stats.gamesPlayed.toString(), inline: true },
          { name: "Guulaha", value: stats.wins.toString(), inline: true },
          { name: "Guuldarooyinka", value: stats.losses.toString(), inline: true },
          { name: "Guulaha imposter ahaan", value: stats.imposterWins.toString(), inline: true },
          { name: "Guulaha Shacab ahaan", value: stats.citizenWins.toString(), inline: true },
          { name: "XP", value: stats.xp.toString(), inline: true },
          { name: "Heerka", value: stats.level.toString(), inline: true }
        )
        .setColor("#ff0000");
      await message.channel.send({ embeds: [embed] });
    }

    if (command === "!leaderboard") {
      const leaderboard = await storage.getLeaderboard();
      if (leaderboard.length === 0) {
        return message.reply("Wali ma jirto xog la heli karo.");
      }
      
      let description = "";
      leaderboard.slice(0, 10).forEach((user, index) => {
        description += `${index + 1}. **${user.displayName}** — ${user.wins} Guulood — Heerka ${user.level}\n`;
      });
      
      const embed = new EmbedBuilder()
        .setTitle("Hogaanka Caalamiga ah")
        .setDescription(description)
        .setColor("#ffd700");
        
      await message.channel.send({ embeds: [embed] });
    }

    if (command === "!fti") {
      const guildId = message.guildId!;
      if (games[guildId]) {
        return message.reply("Ciyaar kale ayaa hadda ka socota server-ka!");
      }

      await message.reply("Fadlan ku soo jawaab tirada ciyaartoyda (3–25):");

      const filter = (m: Message) => m.author.id === message.author.id;
      const collector = message.channel.createMessageCollector({ filter, max: 1, time: 30000 });

      collector.on("collect", async (m) => {
        const num = parseInt(m.content);
        if (isNaN(num) || num < 3 || num > 25) {
          await m.reply("Lambar qaldan ayaa dooratay. Gameka wuu cancel may.");
          return;
        }

        startLobby(guildId, message.author.id, message.channel.id, num);
      });

      collector.on("end", (collected) => {
        if (collected.size === 0) {
          message.channel.send("Waqtiga diyaarinta waa uu dhamaaday.");
        }
      });
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;
    
    const guildId = interaction.guildId!;
    const game = games[guildId];
    if (!game) return;

    if (interaction.customId === "join_lobby") {
      if (game.players.includes(interaction.user.id)) {
        return interaction.reply({ content: "Horey ayaad ugu soo biirtay.", ephemeral: true });
      }
      if (game.players.length >= game.requiredPlayers) {
        return interaction.reply({ content: "Hoolka waa uu buuxaa.", ephemeral: true });
      }
      
      game.players.push(interaction.user.id);
      
      const member = await interaction.guild?.members.fetch(interaction.user.id);
      const displayName = member?.displayName || interaction.user.username;
      
      await storage.updateUserStats(interaction.user.id, { displayName });
      
      await updateLobbyEmbed(guildId);
      interaction.deferUpdate();

      if (game.players.length === game.requiredPlayers) {
        startGame(guildId);
      }
    } else if (interaction.customId === "leave_lobby") {
      if (!game.players.includes(interaction.user.id)) {
        return interaction.reply({ content: "Kuma jirtid hoolka.", ephemeral: true });
      }
      game.players = game.players.filter(id => id !== interaction.user.id);
      await updateLobbyEmbed(guildId);
      interaction.deferUpdate();
    } else if (interaction.customId.startsWith("vote_")) {
      const targetId = interaction.customId.split("_")[1];
      
      // Revote check
      if (game.phase === "revote" && game.tiedPlayers?.includes(interaction.user.id)) {
        return interaction.reply({ content: "Ma codayn kartid dib-u-codaynta sababtoo ah waxaad gashay tie.", ephemeral: true });
      }
      
      if (!game.alivePlayers.includes(interaction.user.id)) {
        return interaction.reply({ content: "Waad dhimatay ama kuma jirtid ciyaarta.", ephemeral: true });
      }
      if (game.votes[interaction.user.id]) {
        return interaction.reply({ content: "Horey ayaad u codayysay.", ephemeral: true });
      }

      game.votes[interaction.user.id] = targetId;
      await interaction.reply({ content: "Codkaagii waa la diwaan galiyey!", ephemeral: true });

      const eligibleVoters = game.phase === "revote" ? 
        game.alivePlayers.filter(id => !game.tiedPlayers?.includes(id)) :
        game.alivePlayers;

      if (Object.keys(game.votes).length >= eligibleVoters.length) {
        processVotes(guildId);
      }
    }
  });

  await client.login(process.env.DISCORD_TOKEN);
}

// Helpers

async function startLobby(guildId: string, hostId: string, channelId: string, requiredPlayers: number) {
  const game = games[guildId] = {
    guildId,
    hostId,
    channelId,
    requiredPlayers,
    players: [],
    alivePlayers: [],
    imposters: [],
    roles: {},
    votes: {},
    phase: "lobby",
    day: 1
  };

  const channel = client.channels.cache.get(channelId) as TextChannel;
  if (!channel) return;

  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder().setCustomId("join_lobby").setLabel("Ku biir").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("leave_lobby").setLabel("Ka bax").setStyle(ButtonStyle.Danger)
    );

  const embed = new EmbedBuilder()
    .setTitle("FTI Hoolka Sugidda")
    .setDescription(`Ciyaartoyda la rabo: ${requiredPlayers}\nKu biiray: 0\nWaqtiga: 60s`)
    .setColor("#00ff00");

  const msg = await channel.send({ embeds: [embed], components: [row] });
  game.discussionMessageId = msg.id;

  game.discussionTimer = setTimeout(() => {
    if (game && game.phase === "lobby" && game.players.length < game.requiredPlayers) {
      channel.send("Ciyaartoy ku filan kuma soo biirin. Ciyaartii waa la joojiyay.");
      delete games[guildId];
    }
  }, 60000);
}

async function updateLobbyEmbed(guildId: string) {
  const game = games[guildId];
  if (!game) return;
  const channel = client.channels.cache.get(game.channelId) as TextChannel;
  if (!channel || !game.discussionMessageId) return;

  const msg = await channel.messages.fetch(game.discussionMessageId).catch(() => null);
  if (!msg) return;

  let playerNames = [];
  for (const id of game.players) {
    const member = await channel.guild.members.fetch(id).catch(() => null);
    playerNames.push(member ? member.displayName : `<@${id}>`);
  }

  const embed = EmbedBuilder.from(msg.embeds[0])
    .setDescription(`Ciyaartoyda la rabo: ${game.requiredPlayers}\nKu biiray: ${game.players.length}\nCiyaartoyda:\n${playerNames.join("\n")}\nWaqtiga: 60s`);

  await msg.edit({ embeds: [embed] }).catch(() => null);
}

async function startGame(guildId: string) {
  const game = games[guildId];
  if (!game) return;
  clearTimeout(game.discussionTimer);

  const channel = client.channels.cache.get(game.channelId) as TextChannel;
  if (game.discussionMessageId) {
    const msg = await channel?.messages.fetch(game.discussionMessageId).catch(() => null);
    if (msg) await msg.delete().catch(() => null);
  }

  game.phase = "discussion";
  game.alivePlayers = [...game.players];

  // Distribute roles
  let numImposters = 1;
  const p = game.requiredPlayers;
  if (p >= 7 && p <= 11) numImposters = 2;
  else if (p >= 12 && p <= 18) numImposters = 3;
  else if (p >= 19 && p <= 25) numImposters = 4;

  const shuffled = [...game.players].sort(() => Math.random() - 0.5);
  game.imposters = shuffled.slice(0, numImposters);
  
  for (const id of shuffled) {
    game.roles[id] = game.imposters.includes(id) ? "imposter" : "citizen";
  }

  // Send DMs
  const imposterNames: string[] = [];
  for (const id of game.imposters) {
    const member = await channel?.guild.members.fetch(id).catch(() => null);
    if (member) imposterNames.push(member.displayName);
  }

  for (const id of game.players) {
    try {
      const user = await client.users.fetch(id);
      if (game.roles[id] === "citizen") {
        await user.send("Waxaad tahay **Shacab**. Soo raadi imposterska.");
      } else {
        let msg = "Waxaad tahay **imposter**.";
        if (game.imposters.length > 1) {
          const others = imposterNames.filter(n => n !== (channel?.guild.members.cache.get(id)?.displayName));
          if (others.length > 0) msg += ` Waxaa imposter kula ah: ${others.join(", ")}`;
        }
        await user.send(msg);
      }
    } catch (e) {
      console.error(`Could not DM ${id}`);
    }
  }

  channel?.send("Roleskiina Luuqa ayaa idinkugu soo direy (DM).");
  
  setTimeout(() => startDiscussion(guildId), 10000);
}

function getDiscussionTime(players: number) {
  if (players >= 3 && players <= 6) return 30;
  if (players >= 7 && players <= 11) return 60;
  return 200;
}

function getVotingTime(players: number) {
  if (players >= 3 && players <= 6) return 60;
  if (players >= 7 && players <= 11) return 90;
  return 120;
}

async function startDiscussion(guildId: string) {
  const game = games[guildId];
  if (!game) return;

  const channel = client.channels.cache.get(game.channelId) as TextChannel;
  if (!channel) return;

  let seconds = getDiscussionTime(game.requiredPlayers);
  const mentions = game.alivePlayers.map(id => `<@${id}>`).join(" ");

  const embed = new EmbedBuilder()
    .setTitle(`Day ${game.day} - Discussion`)
    .setDescription(`Time remaining: ${seconds}s\n\nAlive Players: ${mentions}`)
    .setColor("#ffa500");

  const msg = await channel.send({ embeds: [embed] });
  game.discussionMessageId = msg.id;

  game.discussionTimer = setInterval(async () => {
    seconds--;
    if (seconds <= 0) {
      clearInterval(game.discussionTimer);
      if (msg) await msg.delete().catch(() => null);
      startVoting(guildId);
    } else if (seconds % 5 === 0 || seconds <= 10) {
      const upEmbed = EmbedBuilder.from(embed).setDescription(`Time remaining: ${seconds}s\n\nAlive Players: ${mentions}`);
      await msg.edit({ embeds: [upEmbed] }).catch(() => null);
    }
  }, 1000);
}

async function startVoting(guildId: string, isRevote = false) {
  const game = games[guildId];
  if (!game) return;

  const channel = client.channels.cache.get(game.channelId) as TextChannel;
  if (!channel) return;

  if (!isRevote) {
    // Lock chat
    const everyoneRole = channel.guild.roles.everyone;
    const currentPerms = channel.permissionsFor(everyoneRole)?.has('SendMessages');
    game.lockedChannelPermissions = currentPerms;
    await channel.permissionOverwrites.edit(everyoneRole, { SendMessages: false }).catch(() => null);
  }

  game.phase = isRevote ? "revote" : "voting";
  game.votes = {};

  let seconds = getVotingTime(game.requiredPlayers);

  const embed = new EmbedBuilder()
    .setTitle(isRevote ? `Maalinta ${game.day} - Dib-u-codayn` : `Maalinta ${game.day} - Codaynta`)
    .setDescription(`Waqtiga haray: ${seconds}s\nDooro qofka aad u codaynayso.`)
    .setColor("#ff0000");

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  let currentRow = new ActionRowBuilder<ButtonBuilder>();
  
  const options = isRevote ? game.tiedPlayers! : game.alivePlayers;

  for (let i = 0; i < options.length; i++) {
    if (i > 0 && i % 5 === 0) {
      components.push(currentRow);
      currentRow = new ActionRowBuilder<ButtonBuilder>();
    }
    const member = await channel.guild.members.fetch(options[i]).catch(() => null);
    const name = member ? member.displayName : `Player ${i}`;
    currentRow.addComponents(
      new ButtonBuilder().setCustomId(`vote_${options[i]}`).setLabel(name).setStyle(ButtonStyle.Primary)
    );
  }
  if (currentRow.components.length > 0) {
    components.push(currentRow);
  }

  const mentions = game.alivePlayers.map(id => `<@${id}>`).join(" ");
  await channel.send(`${isRevote ? "Codadkii waa ay siman yihiin! Waa waqtigii dib-u-codaynta!" : "Codayntii waa ay bilaabatay!"} ${mentions}`);
  const msg = await channel.send({ embeds: [embed], components });
  game.voteMessageId = msg.id;

  game.votingTimer = setInterval(async () => {
    seconds--;
    if (seconds <= 0) {
      clearInterval(game.votingTimer);
      processVotes(guildId);
    } else if (seconds % 5 === 0 || seconds <= 10) {
      const upEmbed = EmbedBuilder.from(embed).setDescription(`Waqtiga haray: ${seconds}s\nDooro qofka aad u codaynayso.`);
      await msg.edit({ embeds: [upEmbed] }).catch(() => null);
    }
  }, 1000);
}

async function processVotes(guildId: string) {
  const game = games[guildId];
  if (!game) return;
  clearInterval(game.votingTimer);

  const channel = client.channels.cache.get(game.channelId) as TextChannel;
  if (!channel) return;

  if (game.voteMessageId) {
    const msg = await channel.messages.fetch(game.voteMessageId).catch(() => null);
    if (msg) {
      await msg.edit({ components: [] }).catch(() => null); // disable buttons
    }
  }

  if (game.phase !== "revote") {
    // Unlock chat
    const everyoneRole = channel.guild.roles.everyone;
    await channel.permissionOverwrites.edit(everyoneRole, { SendMessages: game.lockedChannelPermissions !== false }).catch(() => null);
  }

  // Count votes
  const counts: Record<string, number> = {};
  for (const target of Object.values(game.votes)) {
    counts[target] = (counts[target] || 0) + 1;
  }

  const voteList: string[] = [];
  for (const [voterId, targetId] of Object.entries(game.votes)) {
    const voter = await channel.guild.members.fetch(voterId).catch(() => null);
    const target = await channel.guild.members.fetch(targetId).catch(() => null);
    if (voter && target) {
      voteList.push(`**${voter.displayName}** wuxuu u codeeyay **${target.displayName}**`);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle("Natiijada Codaynta")
    .setDescription(voteList.length > 0 ? voteList.join("\n") : "Ma jirin wax codad ah oo la dhiibtay.")
    .setColor("#a9a9a9");
  
  await channel.send({ embeds: [embed] });

  let highestCount = 0;
  let highestPlayers: string[] = [];
  
  for (const [id, count] of Object.entries(counts)) {
    if (count > highestCount) {
      highestCount = count;
      highestPlayers = [id];
    } else if (count === highestCount) {
      highestPlayers.push(id);
    }
  }

  if (highestPlayers.length > 1) {
    game.tiedPlayers = highestPlayers;
    await startVoting(guildId, true);
  } else if (highestPlayers.length === 1) {
    await eliminatePlayer(guildId, highestPlayers[0]);
  } else {
    channel.send("Ma jiro qof la saaray.");
    checkWinCondition(guildId);
  }
}

async function eliminatePlayer(guildId: string, playerId: string) {
  const game = games[guildId];
  if (!game) return;

  const channel = client.channels.cache.get(game.channelId) as TextChannel;
  if (!channel) return;

  game.alivePlayers = game.alivePlayers.filter(id => id !== playerId);
  const role = game.roles[playerId];

  const embed = new EmbedBuilder()
    .setTitle("Ciyaartoy ayaa la saaray")
    .setDescription(`<@${playerId}> waa la saaray.\n\nWaxay ahaayeen **${role === "imposter" ? "imposter" : "Shacab"}**.`)
    .setColor(role === "imposter" ? "#ff0000" : "#00ff00");

  await channel.send({ embeds: [embed] });

  checkWinCondition(guildId);
}

async function checkWinCondition(guildId: string) {
  const game = games[guildId];
  if (!game) return;

  const impostersAlive = game.alivePlayers.filter(id => game.imposters.includes(id)).length;
  const citizensAlive = game.alivePlayers.length - impostersAlive;

  let winner: "imposterska" | "Shacabka" | null = null;

  if (impostersAlive === 0) winner = "Shacabka";
  else if (impostersAlive >= citizensAlive) winner = "imposterska";

  const channel = client.channels.cache.get(game.channelId) as TextChannel;

  if (winner) {
    let rolesText = "";
    for (const id of game.players) {
      const member = await channel?.guild.members.fetch(id).catch(() => null);
      if (member) {
        rolesText += `**${member.displayName}**: ${game.roles[id] === "imposter" ? "imposter(" : "Shacab"}\n`;
      }
    }

    const winEmbed = new EmbedBuilder()
      .setTitle("Ciyaartii waa ay Dhamaatay")
      .setDescription(`**${winner.toUpperCase()} AYAA GUULEYSTAY!**\n\nKaalmihii ciyaartoyda:\n${rolesText}`)
      .setColor(winner === "imposterska" ? "#ff0000" : "#00ff00");
    
    if (channel) await channel.send({ embeds: [winEmbed] });

    // Update stats
    for (const id of game.players) {
      const isImposter = game.roles[id] === "imposter";
      const isWinner = (isImposter && winner === "imposters") || (!isImposter && winner === "citizens");
      
      const stats = await storage.getUserStats(id) || { gamesPlayed: 0, wins: 0, losses: 0, imposterWins: 0, citizenWins: 0, xp: 0, level: 0 } as any;
      
      let xpGained = 10; // participation
      if (isWinner) {
        xpGained += 25;
        if (isImposter) xpGained += 35;
      }

      await storage.updateUserStats(id, {
        gamesPlayed: stats.gamesPlayed + 1,
        wins: stats.wins + (isWinner ? 1 : 0),
        losses: stats.losses + (isWinner ? 0 : 1),
        imposterWins: stats.imposterWins + (isWinner && isImposter ? 1 : 0),
        citizenWins: stats.citizenWins + (isWinner && !isImposter ? 1 : 0),
        xp: stats.xp + xpGained
      });
    }

    delete games[guildId];
  } else {
    game.day++;
    setTimeout(() => startDiscussion(guildId), 3000);
  }
}
