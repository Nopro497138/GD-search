// bot.js (ESM) — Geometry Dash search via GDHistory API
// Node 18+ (global fetch available). package.json: "type": "module".
// Requires: discord.js, @discordjs/rest, discord-api-types, dotenv (optional)
//
// Environment variables (use .env):
// BOT_TOKEN, CLIENT_ID, GUILD_ID
//
// Slash command: /findlevel
// Options: query, lengthcategory, exactlengthseconds, minobjects, maxobjects, exactobjects,
//          requiredobjectids (comma list), difficulty, limit

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

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing environment variables BOT_TOKEN, CLIENT_ID or GUILD_ID.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(TOKEN);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// GDHistory endpoints
const GDH_BASE = 'https://history.geometrydash.eu/api/v1';

/* -----------------------
   Helpers: robust JSON helpers
   ----------------------- */

function tryGet(obj, ...keys) {
  for (const k of keys) {
    if (!obj) continue;
    if (k in obj && obj[k] !== null && obj[k] !== undefined) return obj[k];
    // support nested paths as strings with dots
    if (typeof k === 'string' && k.includes('.')) {
      const parts = k.split('.');
      let cur = obj;
      let ok = true;
      for (const p of parts) {
        if (!cur || !(p in cur)) { ok = false; break; }
        cur = cur[p];
      }
      if (ok && cur !== undefined && cur !== null) return cur;
    }
  }
  return null;
}

// parse comma-separated numbers
function parseIdList(raw) {
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => Number.isFinite(n));
}

// extract level id robustly from GDHistory search result item
function extractLevelIdFromSearchItem(item) {
  // try known field names
  return tryGet(item, 'online_id', 'id', 'level_id', 'levelID', 'levelId', 'onlineId') || null;
}

// extract object count from level detail (try multiple fields)
function extractObjectCount(detail) {
  return tryGet(
    detail,
    'objects',
    'object_count',
    'objectCount',
    'cache_objects',
    'cache_object_count',
    'metadata.objects',
    'meta.objects'
  );
}

// extract length (seconds) from level detail (try multiple fields)
function extractLengthSeconds(detail) {
  // possible fields and formats
  const candidates = [
    'length_seconds',
    'lengthSeconds',
    'length',
    'cache_length',
    'cache_real_length',
    'meta.lengthSeconds',
    'meta.length',
    'metadata.lengthSeconds',
    'metadata.length'
  ];
  for (const c of candidates) {
    const v = tryGet(detail, c);
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const m = v.match(/(\d+(?:\.\d+)?)/);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

/* -----------------------
   GDHistory fetch wrappers
   ----------------------- */

// advanced search: returns an array of search items (best-effort)
async function gdh_searchLevelsAdvanced({ query = '', limit = 30, offset = 0, sort = null, filter = null }) {
  const url = new URL(`${GDH_BASE}/search/level/advanced/`);
  if (query) url.searchParams.set('query', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  if (sort) url.searchParams.set('sort', sort);
  if (filter) url.searchParams.set('filter', filter);

  const res = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`GDHistory search failed: ${res.status} ${res.statusText}`);
  const json = await res.json();

  // GDHistory returns an object; try to locate the list
  // Common shapes: { results: [...], success: true } or direct array
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.results)) return json.results;
  if (Array.isArray(json.data)) return json.data;
  // fallback: try common property names
  for (const k of ['levels', 'items', 'rows']) if (Array.isArray(json[k])) return json[k];

  // sometimes the top-level is object with keys mapping to entries
  // try to extract arrays anywhere in object
  for (const v of Object.values(json)) if (Array.isArray(v)) return v;

  // otherwise, return empty
  return [];
}

// fetch full detail for a single level id
async function gdh_getLevelDetail(levelId) {
  // GDHistory level endpoint
  const url = `${GDH_BASE}/level/${encodeURIComponent(String(levelId))}/`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) {
    // try brief mode (older endpoints)
    try {
      const url2 = `${GDH_BASE}/level/${encodeURIComponent(String(levelId))}/?mode=brief`;
      const r2 = await fetch(url2, { headers: { 'Accept': 'application/json' } });
      if (r2.ok) return await r2.json();
    } catch (e) {}
    throw new Error(`GDHistory level detail failed for ${levelId}: ${res.status}`);
  }
  const json = await res.json();
  // JSON may wrap fields; return object
  return json;
}

/* -----------------------
   Search + filter pipeline
   ----------------------- */

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

  // GDHistory limit can go high; we still limit for performance
  const checkLimit = Math.min(Math.max(limit || 1, 1), 200);

  // Run advanced search. We'll fetch up to `checkLimit` items and iterate checking details.
  const searchItems = await gdh_searchLevelsAdvanced({ query, limit: checkLimit });

  const matches = [];

  for (const item of searchItems) {
    try {
      const levelId = extractLevelIdFromSearchItem(item);
      if (!levelId) continue;

      // fetch detail
      const detail = await gdh_getLevelDetail(levelId);

      // Extract object count and length; be tolerant to different field names/shapes
      const lvlObj = (detail && (detail.level || detail.data || detail)) || detail;
      const objCount = extractObjectCount(lvlObj);
      const lenSec = extractLengthSeconds(lvlObj);

      // normalize numeric values
      const objCountNum = (typeof objCount === 'number') ? objCount : (objCount ? Number(objCount) : null);
      const lenSecNum = (typeof lenSec === 'number') ? lenSec : (lenSec ? Number(lenSec) : null);

      // object filters
      if (exactObjects !== null && objCountNum !== null) {
        if (objCountNum !== exactObjects) continue;
      } else {
        if (objCountNum !== null) {
          if (objCountNum < minObjects) continue;
          if (objCountNum > maxObjects) continue;
        } // if objCountNum is null, allow — we'll skip strict object filters
      }

      // required object IDs: GDHistory does not usually expose raw object lists.
      // If detail contains something like 'object_list' or 'objects_data', try to find IDs.
      if (requiredObjectIds.length > 0) {
        let objectsArray = tryGet(lvlObj, 'object_list', 'objects_list', 'objects_data', 'objectData', 'objects');
        // if objectsArray is an array of objects with 'id' fields
        if (Array.isArray(objectsArray)) {
          const hasAll = requiredObjectIds.every(req => objectsArray.some(o => Number(tryGet(o, 'id', 'object_id', 'objectId')) === Number(req)));
          if (!hasAll) continue;
        } else {
          // if object data not available, we can't verify presence => skip this level for required-object filter
          continue;
        }
      }

      // exact length filter
      if (exactLengthSeconds !== null) {
        if (lenSecNum === null) continue; // can't verify
        if (Math.abs(lenSecNum - exactLengthSeconds) > 0.3) continue;
      }

      // difficulty filter - many level objects include 'cache_filter_difficulty' or 'difficulty'
      if (difficulty) {
        const diffMap = { easy: 1, normal: 2, hard: 3, harder: 4, insane: 5, demon: 6 }; // approximate mapping if used
        const levelDiff = tryGet(lvlObj, 'cache_filter_difficulty', 'difficulty', 'level_difficulty', 'difficulty_id');
        const levelDiffNum = levelDiff ? Number(levelDiff) : null;
        if (typeof difficulty === 'string' && difficulty.toLowerCase() !== 'auto') {
          const wanted = difficulty.toLowerCase();
          if (wanted === 'demon') {
            // If levelDiffNum exists and not >=6, skip; otherwise allow string compare
            if (levelDiffNum !== null) {
              if (!(levelDiffNum >= 6)) continue;
            } else {
              // fallback: check textual difficulty if available
              const diffText = tryGet(lvlObj, 'difficulty_text', 'difficultyName', 'difficultyString');
              if (diffText && String(diffText).toLowerCase().indexOf('dem') === -1) continue;
            }
          } else {
            if (levelDiffNum !== null && diffMap[wanted]) {
              if (levelDiffNum !== diffMap[wanted]) continue;
            }
          }
        }
      }

      matches.push({ levelId, searchItem: item, detail: lvlObj, objectCount: objCountNum, lengthSeconds: lenSecNum });

    } catch (err) {
      // ignore per-level errors and continue
      console.warn('Level processing skipped:', err && err.message ? err.message : err);
      continue;
    }
  }

  return matches;
}

/* -----------------------
   Discord command + embed UI
   ----------------------- */

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
      { name: 'limit', type: 4, description: 'How many search results to check (default 30)', required: false }
    ]
  }
];

// register commands (guild-scoped for fast deployment)
(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
})();

function makeResultsEmbed(query, matches, page = 0, perPage = 5) {
  const embed = new EmbedBuilder()
    .setTitle('🔎 Geometry Dash Level Search Results')
    .setDescription(query ? `Query: \`${query}\`` : 'No query provided')
    .setTimestamp();

  if (matches.length === 0) {
    embed.addFields({ name: 'No results', value: 'No levels matched your filters. Try relaxing them.' });
    return embed;
  }

  const start = page * perPage;
  const slice = matches.slice(start, start + perPage);
  for (const m of slice) {
    const name = tryGet(m.detail, 'name', 'levelName') || tryGet(m.searchItem, 'name') || 'Unknown';
    const author = tryGet(m.detail, 'author', 'creator', 'creator_name') || tryGet(m.searchItem, 'author') || 'Unknown';
    const levelID = m.levelId;
    const objectsText = (m.objectCount !== null && m.objectCount !== undefined) ? `Objects: **${m.objectCount}**` : 'Objects: N/A';
    const lengthText = (m.lengthSeconds !== null && m.lengthSeconds !== undefined) ? `Length: **${Number(m.lengthSeconds).toFixed(1)}s**` : 'Length: N/A';
    const preview = `https://gdbrowser.com/level/${levelID}`;

    const value = `ID: \`${levelID}\` • Creator: **${author}**\n${objectsText} • ${lengthText}\nPreview: ${preview}`;
    embed.addFields({ name: `${name}`, value });
  }

  embed.setFooter({ text: `Showing ${start + 1}-${Math.min(start + perPage, matches.length)} of ${matches.length}` });
  return embed;
}

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
      try { await reply.edit({ components: [] }); } catch (e) {}
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
