// bot.js (ESM-compatible)
// Node 18+ / 22+ recommended
// Make sure package.json contains "type": "module" if you want to run as ESM.
// dotenv is optional; create a .env with BOT_TOKEN, CLIENT_ID, GUILD_ID if you use it.

import dotenv from 'dotenv';
dotenv.config();

import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';

// dynamic import for gd.js so this file stays ESM-friendly
const GDModule = await import('gd.js');
const GD = GDModule.default || GDModule.GD || GDModule;

// Environment variables
const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // application id
const GUILD_ID = process.env.GUILD_ID;   // recommended for testing

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing environment variables. Please set BOT_TOKEN, CLIENT_ID and GUILD_ID.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(TOKEN);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const gd = new GD({ logLevel: 0 });

// Register command (guild-scoped) on startup
const commands = [
  {
    name: 'findlevel',
    description: 'Search Geometry Dash levels with advanced filters',
    options: [
      { name: 'query', type: 3, description: 'Free-text search (level name / creator / tags)', required: false },
      { name: 'lengthcategory', type: 3, description: 'Length category: short|normal|long|xl', required: false },
      { name: 'exactlengthseconds', type: 4, description: 'Exact level length in seconds (best-effort)', required: false },
      { name: 'minobjects', type: 4, description: 'Minimum object count', required: false },
      { name: 'maxobjects', type: 4, description: 'Maximum object count', required: false },
      { name: 'exactobjects', type: 4, description: 'Exact object count (overrides min/max)', required: false },
      { name: 'requiredobjectids', type: 3, description: 'Comma-separated object IDs (e.g. 1,57,100)', required: false },
      { name: 'difficulty', type: 3, description: 'Difficulty filter (auto|easy|normal|hard|harder|insane|demon)', required: false },
      { name: 'limit', type: 4, description: 'How many levels to check (max 100, default 30)', required: false }
    ]
  }
];

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
})();

// Helper: parse comma-separated int list
function parseIdList(raw) {
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => Number.isFinite(n));
}

// Helper: best-effort extract length seconds from decoded data or level object
function extractLengthSeconds(level, decoded) {
  try {
    if (decoded && decoded.parsed && decoded.parsed.meta) {
      const meta = decoded.parsed.meta;
      if (typeof meta.lengthSeconds === 'number') return meta.lengthSeconds;
      if (typeof meta.length === 'number') return meta.length;
      if (typeof meta.realLength === 'number') return meta.realLength;
      if (typeof meta.length === 'string') {
        const m = meta.length.match(/(\d+(?:\.\d+)?)/);
        if (m) return Number(m[1]);
      }
    }
  } catch (e) {}

  try {
    if (level && level.length) {
      if (typeof level.length === 'number') return level.length;
      if (typeof level.length.seconds === 'number') return level.length.seconds;
      if (typeof level.length.raw === 'number') return level.length.raw;
      if (typeof level.length.raw === 'string') {
        const m = level.length.raw.match(/(\d+(?:\.\d+)?)/);
        if (m) return Number(m[1]);
      }
    }
  } catch (e) {}

  return null;
}

// Search + filter pipeline
async function findLevelsWithFilters(opts) {
  const {
    query = '',
    lengthCategory = null,
    minObjects = 0,
    maxObjects = Infinity,
    exactObjects = null,
    requiredObjectIds = [],
    exactLengthSeconds = null,
    difficulty = null,
    limit = 30
  } = opts;

  const searchOpts = {};
  if (query) searchOpts.query = query;
  if (lengthCategory) searchOpts.length = lengthCategory;
  if (difficulty && difficulty.toLowerCase() !== 'auto') searchOpts.difficulty = difficulty.toLowerCase();

  const checkLimit = Math.min(Math.max(limit || 1, 1), 100);
  const results = [];

  const searched = await gd.levels.search(searchOpts, checkLimit);

  for (const s of searched) {
    try {
      const lvl = await s.resolve();
      const decoded = await lvl.decodeData();
      const objects = (decoded && decoded.parsed && decoded.parsed.data) || [];
      const objCount = objects.length;

      if (exactObjects !== null && objCount !== exactObjects) continue;
      if (objCount < minObjects) continue;
      if (objCount > maxObjects) continue;

      if (requiredObjectIds.length > 0) {
        const hasAll = requiredObjectIds.every(req => objects.some(o => Number(o.id) === Number(req)));
        if (!hasAll) continue;
      }

      if (exactLengthSeconds !== null) {
        const lenSec = extractLengthSeconds(lvl, decoded);
        if (lenSec === null) continue;
        if (Math.abs(lenSec - exactLengthSeconds) > 0.3) continue;
      }

      results.push({ lvl, decoded, objectCount: objCount });
    } catch (err) {
      console.warn('Level skipped (resolve/decode error):', err && err.message ? err.message : err);
      continue;
    }
  }

  return results;
}

// Utility to create a clean embed for results
function makeResultsEmbed(query, matches, page = 0, perPage = 5) {
  const embed = new EmbedBuilder()
    .setTitle('🔎 Geometry Dash Level Search Results')
    .setDescription(query ? `Query: \`${query}\`` : 'Query: `—`')
    .setTimestamp();

  const start = page * perPage;
  const slice = matches.slice(start, start + perPage);
  if (slice.length === 0) {
    embed.addFields({ name: 'No matches', value: 'No levels matched your filters. Try relaxing filters or increase limit.' });
    return embed;
  }

  for (const item of slice) {
    const lvl = item.lvl;
    const decoded = item.decoded;
    const levelID = lvl.levelID || lvl.id || lvl.level_id || 'unknown';
    const name = lvl.name || 'Unknown';
    const author = (lvl.creator && (lvl.creator.name || lvl.creatorName)) || lvl.author || 'Unknown';

    const lengthSec = extractLengthSeconds(lvl, decoded);
    const lenText = lengthSec !== null ? `${lengthSec.toFixed(1)}s` : 'N/A';

    const val = `ID: \`${levelID}\`  •  Creator: **${author}**\nObjects: **${item.objectCount}**  •  Length: **${lenText}**\nPreview: https://gdbrowser.com/level/${levelID}`;
    embed.addFields({ name: `${name}`, value: val });
  }

  return embed;
}

// Simple paginator buttons (Prev / Next)
function makePaginatorRow(page, totalPages) {
  const row = new ActionRowBuilder();
  const prev = new ButtonBuilder().setCustomId('prev_page').setLabel('⬅️ Prev').setStyle(ButtonStyle.Primary).setDisabled(page <= 0);
  const next = new ButtonBuilder().setCustomId('next_page').setLabel('Next ➡️').setStyle(ButtonStyle.Primary).setDisabled(page >= totalPages - 1);
  row.addComponents(prev, next);
  return row;
}

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'findlevel') return;

    await interaction.deferReply();

    const query = interaction.options.getString('query') || '';
    const lengthCategory = interaction.options.getString('lengthcategory') || null;
    const exactLengthSeconds = interaction.options.getInteger('exactlengthseconds');
    const minObjects = interaction.options.getInteger('minobjects') || 0;
    const maxObjects = interaction.options.getInteger('maxobjects') || Infinity;
    const exactObjects = interaction.options.getInteger('exactobjects');
    const requiredObjectIds = parseIdList(interaction.options.getString('requiredobjectids') || '');
    const difficulty = interaction.options.getString('difficulty') || null;
    const limit = interaction.options.getInteger('limit') || 30;

    const opts = {
      query,
      lengthCategory,
      minObjects,
      maxObjects,
      exactObjects: (typeof exactObjects === 'number') ? exactObjects : null,
      requiredObjectIds,
      exactLengthSeconds: (typeof exactLengthSeconds === 'number') ? exactLengthSeconds : null,
      difficulty,
      limit
    };

    const matches = await findLevelsWithFilters(opts);

    const perPage = 5;
    const totalPages = Math.max(1, Math.ceil(matches.length / perPage));
    let page = 0;
    const embed = makeResultsEmbed(query, matches, page, perPage);

    if (matches.length === 0) {
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const components = totalPages > 1 ? [makePaginatorRow(page, totalPages)] : [];
    const reply = await interaction.editReply({ embeds: [embed], components });

    if (totalPages <= 1) return;

    const collector = reply.createMessageComponentCollector({ time: 120000 });
    collector.on('collect', async (i) => {
      if (i.user.id !== interaction.user.id) {
        await i.reply({ content: 'These buttons are not for you.', ephemeral: true });
        return;
      }
      if (i.customId === 'prev_page') page = Math.max(0, page - 1);
      if (i.customId === 'next_page') page = Math.min(totalPages - 1, page + 1);

      const newEmbed = makeResultsEmbed(query, matches, page, perPage);
      const newComponents = [makePaginatorRow(page, totalPages)];
      await i.update({ embeds: [newEmbed], components: newComponents });
    });

    collector.on('end', async () => {
      try {
        await reply.edit({ components: [] });
      } catch (e) {}
    });

  } catch (err) {
    console.error('Interaction error:', err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: 'An error occurred while processing your request.' });
    } else {
      await interaction.reply({ content: 'An error occurred while processing your request.', ephemeral: true });
    }
  }
});

client.login(TOKEN);
