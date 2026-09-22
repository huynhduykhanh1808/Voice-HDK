const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  PermissionsBitField,
  PermissionFlagsBits,
  OverwriteType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder
} = require('discord.js');

const { Pool } = require('pg');
const http = require('http');

const BOT_NAME = 'Voice HDK';
const BOT_VERSION = '10.0.0';

const TOKEN = process.env.DISCORD_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT || 3000);

const TIME_ZONE = 'Asia/Ho_Chi_Minh';

const GENERATOR_NAME = '➕ Tạo phòng';
const ROOM_PREFIX = '🔊・';

const CHAT_LOG_NAME = '💬・nhật-ký-chat';
const ACTION_LOG_NAME = '⚙️・nhật-ký-chức-năng';

const NOTICE_MS = 5000;
const COOLDOWN_MS = 1500;

const TRANSFER_MS = 60 * 1000;
const OWNER_GRACE_MS = 10 * 60 * 1000;
const OWNER_RETRY_MS = 60 * 1000;

const EMPTY_DELETE_MS = 2500;
const REGION_CACHE_MS = 30 * 60 * 1000;

if (!TOKEN) {
  throw new Error('Thiếu biến môi trường DISCORD_TOKEN.');
}

if (!DATABASE_URL) {
  throw new Error('Thiếu biến môi trường DATABASE_URL.');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.User,
    Partials.GuildMember
  ]
});

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : undefined
});

const createLocks = new Map();
const panelLocks = new Map();
const roomLocks = new Map();

const cooldowns = new Map();
const selectedMembers = new Map();
const pendingTransfers = new Map();
const setupSessions = new Map();

const emptyTimers = new Map();
const absenceTimers = new Map();

const cleanupGuilds = new Set();

let regionCache = {
  fetchedAt: 0,
  regions: []
};

let shuttingDown = false;

function logError(scope, error) {
  console.error(
    `[${BOT_NAME}] [${scope}]`,
    error?.stack || error?.message || String(error)
  );
}

pool.on('error', error => {
  logError('POSTGRES_POOL', error);
});

client.on(Events.Error, error => {
  logError('DISCORD_CLIENT', error);
});

client.on(Events.Warn, warning => {
  console.warn(`[${BOT_NAME}] [DISCORD_WARN]`, warning);
});

function isSnowflake(value) {
  return /^\d{16,22}$/.test(String(value || ''));
}

function cleanText(value, max = 80) {
  return String(value || '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanRoomName(value) {
  let name = cleanText(value, 90);

  if (name.startsWith(ROOM_PREFIX)) {
    name = name.slice(ROOM_PREFIX.length);
  }

  return name
    .replace(/[<>@#`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function memberName(member) {
  return cleanText(
    member?.displayName ||
      member?.user?.globalName ||
      member?.user?.username ||
      'Thành viên',
    50
  );
}

function vietnamTime(date = new Date()) {
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour12: false
  })
    .format(date)
    .replace(',', '');
}

function relativeTime(value) {
  const timestamp =
    value instanceof Date
      ? value.getTime()
      : new Date(value).getTime();

  return `<t:${Math.floor(timestamp / 1000)}:R>`;
}

function isVoiceChannel(channel) {
  return Boolean(
    channel &&
      (channel.type === ChannelType.GuildVoice ||
        channel.type === ChannelType.GuildStageVoice)
  );
}

function isTextChannel(channel) {
  return Boolean(
    channel?.isTextBased?.() &&
      typeof channel.send === 'function'
  );
}

function isCategory(channel) {
  return channel?.type === ChannelType.GuildCategory;
}

function isHuman(member) {
  return Boolean(member && !member.user?.bot);
}

function humanMembers(channel) {
  if (!channel?.members) {
    return [];
  }

  return [...channel.members.values()].filter(isHuman);
}

function voiceChannelIdOf(guild, memberId) {
  return (
    guild?.voiceStates?.cache?.get(String(memberId))?.channelId ||
    null
  );
}

async function withLock(map, key, callback) {
  const normalizedKey = String(key);

  while (map.has(normalizedKey)) {
    await map.get(normalizedKey);
  }

  let release;

  const gate = new Promise(resolve => {
    release = resolve;
  });

  map.set(normalizedKey, gate);

  try {
    return await callback();
  } finally {
    map.delete(normalizedKey);
    release();
  }
}

function withCreateLock(guildId, memberId, callback) {
  return withLock(
    createLocks,
    `${guildId}:${memberId}`,
    callback
  );
}

function withPanelLock(channelId, callback) {
  return withLock(panelLocks, channelId, callback);
}

function withRoomLock(channelId, callback) {
  return withLock(roomLocks, channelId, callback);
}

function useCooldown(interaction, action) {
  const key = [
    interaction.guildId,
    interaction.user.id,
    action
  ].join(':');

  const now = Date.now();
  const expiresAt = cooldowns.get(key) || 0;

  if (expiresAt > now) {
    return true;
  }

  cooldowns.set(key, now + COOLDOWN_MS);

  const timer = setTimeout(() => {
    cooldowns.delete(key);
  }, COOLDOWN_MS + 1000);

  timer.unref?.();

  return false;
}

async function fetchMember(guild, memberId) {
  if (!guild || !isSnowflake(memberId)) {
    return null;
  }

  try {
    return await guild.members.fetch({
      user: String(memberId),
      force: true
    });
  } catch (_) {
    return null;
  }
}

async function fetchChannel(guild, channelId) {
  if (!guild || !isSnowflake(channelId)) {
    return null;
  }

  try {
    return await guild.channels.fetch(String(channelId));
  } catch (_) {
    return null;
  }
}

async function fetchMessage(channel, messageId) {
  if (!channel?.messages || !isSnowflake(messageId)) {
    return null;
  }

  try {
    return await channel.messages.fetch(String(messageId));
  } catch (_) {
    return null;
  }
}

async function deleteMessageSafe(message) {
  if (!message) {
    return false;
  }

  try {
    await message.delete();
    return true;
  } catch (_) {
    return false;
  }
}

async function deleteChannelSafe(channel, reason) {
  if (!channel) {
    return false;
  }

  try {
    await channel.delete(reason);
    return true;
  } catch (error) {
    logError('DELETE_CHANNEL', error);
    return false;
  }
}

function noticePrefix(type) {
  switch (type) {
    case 'success':
      return '🟢';
    case 'warning':
      return '🟠';
    case 'error':
      return '🔴';
    default:
      return '🔵';
  }
}

function noticeText(text, type = 'info') {
  return `${noticePrefix(type)} ${text}`;
}

function scheduleReplyDelete(interaction, delay = NOTICE_MS) {
  const timer = setTimeout(async () => {
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.deleteReply();
      }
    } catch (_) {}
  }, delay);

  timer.unref?.();
}

async function tempReply(interaction, text, type = 'info') {
  const content = noticeText(text, type);

  try {
    if (interaction.deferred || interaction.replied) {
      const message = await interaction.followUp({
        content,
        ephemeral: true,
        fetchReply: true
      });

      const timer = setTimeout(() => {
        message.delete().catch(() => {});
      }, NOTICE_MS);

      timer.unref?.();

      return message;
    }

    await interaction.reply({
      content,
      ephemeral: true
    });

    scheduleReplyDelete(interaction);
  } catch (error) {
    logError('TEMP_REPLY', error);
  }

  return null;
}

async function deferComponent(interaction) {
  if (interaction.deferred || interaction.replied) {
    return;
  }

  try {
    await interaction.deferUpdate();
  } catch (_) {}
}

async function sendTempRoomNotice(channel, text, type = 'info') {
  if (!isTextChannel(channel)) {
    return null;
  }

  try {
    const message = await channel.send({
      content: noticeText(text, type),
      allowedMentions: {
        parse: []
      }
    });

    const timer = setTimeout(() => {
      message.delete().catch(() => {});
    }, NOTICE_MS);

    timer.unref?.();

    return message;
  } catch (_) {
    return null;
  }
}

async function memberInExactRoom(guild, memberId, channelId) {
  const member = await fetchMember(guild, memberId);

  if (!member) {
    return null;
  }

  const actualChannelId =
    voiceChannelIdOf(guild, member.id) ||
    member.voice?.channelId ||
    null;

  if (
    String(actualChannelId || '') !==
    String(channelId)
  ) {
    return null;
  }

  return member;
}

async function disconnectExactMember(
  guild,
  memberId,
  channelId,
  reason
) {
  const member = await memberInExactRoom(
    guild,
    memberId,
    channelId
  );

  if (!member) {
    return {
      ok: false,
      reason: 'NOT_IN_ROOM'
    };
  }

  try {
    await member.voice.disconnect(reason);

    return {
      ok: true,
      reason: null
    };
  } catch (error) {
    logError('DISCONNECT_MEMBER', error);

    return {
      ok: false,
      reason: 'FAILED'
    };
  }
}

async function moveExactMember(
  guild,
  memberId,
  expectedChannelId,
  destination,
  reason
) {
  const member = await memberInExactRoom(
    guild,
    memberId,
    expectedChannelId
  );

  if (!member) {
    return false;
  }

  try {
    await member.voice.setChannel(destination, reason);
    return true;
  } catch (error) {
    logError('MOVE_MEMBER', error);
    return false;
  }
}

async function initDatabase() {
  const db = await pool.connect();

  try {
    await db.query('BEGIN');

    await db.query(`
      CREATE TABLE IF NOT EXISTS guild_config (
        guild_id TEXT PRIMARY KEY,
        button_category_id TEXT,
        blog_category_id TEXT,
        generator_channel_id TEXT,
        chat_log_channel_id TEXT,
        action_log_channel_id TEXT,
        display_name TEXT NOT NULL DEFAULT 'Server',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        panel_message_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS rooms_one_owner_per_guild
      ON rooms (guild_id, owner_id)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS rooms_guild_idx
      ON rooms (guild_id)
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS room_bans (
        channel_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        banned_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (channel_id, member_id)
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS room_presence (
        channel_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (channel_id, member_id)
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS room_presence_order_idx
      ON room_presence (channel_id, joined_at)
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS owner_absence (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        deadline_at TIMESTAMPTZ NOT NULL,
        notice_message_id TEXT
      )
    `);

    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

async function getConfig(guildId) {
  const result = await pool.query(
    `
      SELECT *
      FROM guild_config
      WHERE guild_id = $1
      LIMIT 1
    `,
    [String(guildId)]
  );

  return result.rows[0] || null;
}

async function saveConfig({
  guildId,
  buttonCategoryId,
  blogCategoryId,
  generatorChannelId,
  chatLogChannelId,
  actionLogChannelId,
  displayName
}) {
  const result = await pool.query(
    `
      INSERT INTO guild_config (
        guild_id,
        button_category_id,
        blog_category_id,
        generator_channel_id,
        chat_log_channel_id,
        action_log_channel_id,
        display_name,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (guild_id)
      DO UPDATE SET
        button_category_id = EXCLUDED.button_category_id,
        blog_category_id = EXCLUDED.blog_category_id,
        generator_channel_id = EXCLUDED.generator_channel_id,
        chat_log_channel_id = EXCLUDED.chat_log_channel_id,
        action_log_channel_id = EXCLUDED.action_log_channel_id,
        display_name = EXCLUDED.display_name,
        updated_at = NOW()
      RETURNING *
    `,
    [
      String(guildId),
      buttonCategoryId ? String(buttonCategoryId) : null,
      blogCategoryId ? String(blogCategoryId) : null,
      generatorChannelId ? String(generatorChannelId) : null,
      chatLogChannelId ? String(chatLogChannelId) : null,
      actionLogChannelId ? String(actionLogChannelId) : null,
      cleanText(displayName || 'Server', 80)
    ]
  );

  return result.rows[0];
}

async function clearTrackedConfigChannel(guildId, field) {
  const allowedFields = new Set([
    'generator_channel_id',
    'chat_log_channel_id',
    'action_log_channel_id'
  ]);

  if (!allowedFields.has(field)) {
    throw new Error('Invalid config channel field.');
  }

  await pool.query(
    `
      UPDATE guild_config
      SET ${field} = NULL,
          updated_at = NOW()
      WHERE guild_id = $1
    `,
    [String(guildId)]
  );
}

async function deleteGuildConfig(guildId, db = pool) {
  await db.query(
    `
      DELETE FROM guild_config
      WHERE guild_id = $1
    `,
    [String(guildId)]
  );
}

async function getRoom(channelId) {
  const result = await pool.query(
    `
      SELECT *
      FROM rooms
      WHERE channel_id = $1
      LIMIT 1
    `,
    [String(channelId)]
  );

  return result.rows[0] || null;
}

async function getOwnedRoom(guildId, ownerId) {
  const result = await pool.query(
    `
      SELECT *
      FROM rooms
      WHERE guild_id = $1
        AND owner_id = $2
      LIMIT 1
    `,
    [
      String(guildId),
      String(ownerId)
    ]
  );

  return result.rows[0] || null;
}

async function getGuildRooms(guildId) {
  const result = await pool.query(
    `
      SELECT *
      FROM rooms
      WHERE guild_id = $1
      ORDER BY created_at ASC
    `,
    [String(guildId)]
  );

  return result.rows;
}

async function createRoomRecord(
  guildId,
  channelId,
  ownerId
) {
  const result = await pool.query(
    `
      INSERT INTO rooms (
        channel_id,
        guild_id,
        owner_id
      )
      VALUES ($1,$2,$3)
      RETURNING *
    `,
    [
      String(channelId),
      String(guildId),
      String(ownerId)
    ]
  );

  return result.rows[0];
}

async function setRoomPanelMessage(
  channelId,
  messageId
) {
  const result = await pool.query(
    `
      UPDATE rooms
      SET panel_message_id = $2
      WHERE channel_id = $1
      RETURNING *
    `,
    [
      String(channelId),
      messageId ? String(messageId) : null
    ]
  );

  return result.rows[0] || null;
}

async function updateRoomOwner(
  channelId,
  ownerId,
  db = pool
) {
  const result = await db.query(
    `
      UPDATE rooms
      SET owner_id = $2
      WHERE channel_id = $1
      RETURNING *
    `,
    [
      String(channelId),
      String(ownerId)
    ]
  );

  return result.rows[0] || null;
}

async function deleteRoomData(
  channelId,
  db = pool
) {
  const id = String(channelId);

  await db.query(
    `DELETE FROM room_bans WHERE channel_id = $1`,
    [id]
  );

  await db.query(
    `DELETE FROM room_presence WHERE channel_id = $1`,
    [id]
  );

  await db.query(
    `DELETE FROM owner_absence WHERE channel_id = $1`,
    [id]
  );

  await db.query(
    `DELETE FROM rooms WHERE channel_id = $1`,
    [id]
  );
}

async function deleteGuildVoiceData(
  guildId,
  db = pool
) {
  const id = String(guildId);

  await db.query(
    `DELETE FROM room_bans WHERE guild_id = $1`,
    [id]
  );

  await db.query(
    `DELETE FROM room_presence WHERE guild_id = $1`,
    [id]
  );

  await db.query(
    `DELETE FROM owner_absence WHERE guild_id = $1`,
    [id]
  );

  await db.query(
    `DELETE FROM rooms WHERE guild_id = $1`,
    [id]
  );
}

async function addPresence(
  guildId,
  channelId,
  memberId,
  joinedAt = new Date()
) {
  await pool.query(
    `
      INSERT INTO room_presence (
        guild_id,
        channel_id,
        member_id,
        joined_at
      )
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (channel_id, member_id)
      DO NOTHING
    `,
    [
      String(guildId),
      String(channelId),
      String(memberId),
      joinedAt
    ]
  );
}

async function removePresence(
  channelId,
  memberId
) {
  await pool.query(
    `
      DELETE FROM room_presence
      WHERE channel_id = $1
        AND member_id = $2
    `,
    [
      String(channelId),
      String(memberId)
    ]
  );
}

async function getPresence(channelId) {
  const result = await pool.query(
    `
      SELECT *
      FROM room_presence
      WHERE channel_id = $1
      ORDER BY joined_at ASC
    `,
    [String(channelId)]
  );

  return result.rows;
}

async function addBan(
  guildId,
  channelId,
  memberId,
  bannedBy
) {
  await pool.query(
    `
      INSERT INTO room_bans (
        guild_id,
        channel_id,
        member_id,
        banned_by
      )
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (channel_id, member_id)
      DO UPDATE SET
        banned_by = EXCLUDED.banned_by,
        created_at = NOW()
    `,
    [
      String(guildId),
      String(channelId),
      String(memberId),
      bannedBy ? String(bannedBy) : null
    ]
  );
}

async function removeBan(
  channelId,
  memberId
) {
  await pool.query(
    `
      DELETE FROM room_bans
      WHERE channel_id = $1
        AND member_id = $2
    `,
    [
      String(channelId),
      String(memberId)
    ]
  );
}

async function memberIsBanned(
  channelId,
  memberId
) {
  const result = await pool.query(
    `
      SELECT 1
      FROM room_bans
      WHERE channel_id = $1
        AND member_id = $2
      LIMIT 1
    `,
    [
      String(channelId),
      String(memberId)
    ]
  );

  return result.rowCount > 0;
}

async function clearRoomBans(
  channelId,
  db = pool
) {
  await db.query(
    `
      DELETE FROM room_bans
      WHERE channel_id = $1
    `,
    [String(channelId)]
  );
}

async function getAbsence(channelId) {
  const result = await pool.query(
    `
      SELECT *
      FROM owner_absence
      WHERE channel_id = $1
      LIMIT 1
    `,
    [String(channelId)]
  );

  return result.rows[0] || null;
}

async function saveAbsence({
  guildId,
  channelId,
  ownerId,
  deadlineAt,
  noticeMessageId
}) {
  const result = await pool.query(
    `
      INSERT INTO owner_absence (
        channel_id,
        guild_id,
        owner_id,
        deadline_at,
        notice_message_id
      )
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (channel_id)
      DO UPDATE SET
        guild_id = EXCLUDED.guild_id,
        owner_id = EXCLUDED.owner_id,
        deadline_at = EXCLUDED.deadline_at,
        notice_message_id = EXCLUDED.notice_message_id
      RETURNING *
    `,
    [
      String(channelId),
      String(guildId),
      String(ownerId),
      deadlineAt,
      noticeMessageId ? String(noticeMessageId) : null
    ]
  );

  return result.rows[0];
}

async function deleteAbsence(
  channelId,
  db = pool
) {
  await db.query(
    `
      DELETE FROM owner_absence
      WHERE channel_id = $1
    `,
    [String(channelId)]
  );
}

function clearEmptyTimer(channelId) {
  const key = String(channelId);
  const timer = emptyTimers.get(key);

  if (!timer) {
    return;
  }

  clearTimeout(timer);
  emptyTimers.delete(key);
}

function clearAbsenceTimer(channelId) {
  const key = String(channelId);
  const timer = absenceTimers.get(key);

  if (!timer) {
    return;
  }

  clearTimeout(timer);
  absenceTimers.delete(key);
}

function clearTransfer(channelId) {
  const key = String(channelId);
  const transfer = pendingTransfers.get(key);

  if (transfer?.timer) {
    clearTimeout(transfer.timer);
  }

  pendingTransfers.delete(key);
}

function selectedKey(
  guildId,
  channelId,
  ownerId
) {
  return `${guildId}:${channelId}:${ownerId}`;
}

function setSelected(
  guildId,
  channelId,
  ownerId,
  memberId
) {
  selectedMembers.set(
    selectedKey(
      guildId,
      channelId,
      ownerId
    ),
    {
      memberId: String(memberId),
      createdAt: Date.now()
    }
  );
}

function getSelected(
  guildId,
  channelId,
  ownerId
) {
  const key = selectedKey(
    guildId,
    channelId,
    ownerId
  );

  const state = selectedMembers.get(key);

  if (!state) {
    return null;
  }

  if (
    Date.now() - state.createdAt >
    10 * 60 * 1000
  ) {
    selectedMembers.delete(key);
    return null;
  }

  return state.memberId;
}

function clearSelected(
  guildId,
  channelId,
  ownerId
) {
  selectedMembers.delete(
    selectedKey(
      guildId,
      channelId,
      ownerId
    )
  );
}

function clearRoomRuntime(channelId) {
  clearEmptyTimer(channelId);
  clearAbsenceTimer(channelId);
  clearTransfer(channelId);

  const channelPart = `:${channelId}:`;

  for (const key of selectedMembers.keys()) {
    if (key.includes(channelPart)) {
      selectedMembers.delete(key);
    }
  }
}

async function editMemberPermission(
  channel,
  memberId,
  permissions,
  reason
) {
  const member = await fetchMember(
    channel.guild,
    memberId
  );

  if (!member) {
    return false;
  }

  try {
    await channel.permissionOverwrites.edit(
      member,
      permissions,
      { reason }
    );

    return true;
  } catch (error) {
    logError('PERMISSION_EDIT', error);
    return false;
  }
}

async function deleteMemberPermission(
  channel,
  memberId,
  reason
) {
  const member = await fetchMember(
    channel.guild,
    memberId
  );

  if (member) {
    try {
      await channel.permissionOverwrites.delete(
        member,
        reason
      );

      return true;
    } catch (error) {
      logError('PERMISSION_DELETE', error);
      return false;
    }
  }

  const overwrite =
    channel.permissionOverwrites.cache.get(
      String(memberId)
    );

  if (!overwrite) {
    return true;
  }

  try {
    await overwrite.delete(reason);
    return true;
  } catch (error) {
    logError(
      'PERMISSION_DELETE_STALE',
      error
    );

    return false;
  }
}

async function grantOwner(
  channel,
  ownerId
) {
  return editMemberPermission(
    channel,
    ownerId,
    {
      ViewChannel: true,
      Connect: true,
      Speak: true,
      Stream: true,
      UseVAD: true
    },
    `${BOT_NAME} • quyền chủ phòng`
  );
}

async function grantInvite(
  channel,
  memberId
) {
  return editMemberPermission(
    channel,
    memberId,
    {
      ViewChannel: true,
      Connect: true
    },
    `${BOT_NAME} • mời vào phòng`
  );
}

async function denyMember(
  channel,
  memberId
) {
  return editMemberPermission(
    channel,
    memberId,
    {
      ViewChannel: false,
      Connect: false
    },
    `${BOT_NAME} • cấm khỏi phòng`
  );
}

async function clearMemberOverwrites(
  channel,
  preserveIds = []
) {
  const preserve = new Set(
    preserveIds.map(String)
  );

  const overwrites = [
    ...channel.permissionOverwrites.cache.values()
  ].filter(
    overwrite =>
      overwrite.type === OverwriteType.Member &&
      !preserve.has(String(overwrite.id))
  );

  for (const overwrite of overwrites) {
    try {
      await overwrite.delete(
        `${BOT_NAME} • đặt lại phòng`
      );
    } catch (error) {
      logError(
        'CLEAR_MEMBER_OVERWRITE',
        error
      );

      return false;
    }
  }

  return true;
}

async function getVoiceRegions(force = false) {
  if (
    !force &&
    regionCache.regions.length &&
    Date.now() - regionCache.fetchedAt <
      REGION_CACHE_MS
  ) {
    return regionCache.regions;
  }

  try {
    const regions =
      await client.fetchVoiceRegions();

    regionCache = {
      fetchedAt: Date.now(),
      regions: [...regions.values()]
    };

    return regionCache.regions;
  } catch (error) {
    logError('VOICE_REGIONS', error);
    return regionCache.regions;
  }
}

async function setVoiceRegion(
  channel,
  regionId
) {
  try {
    if (regionId === 'automatic') {
      await channel.setRTCRegion(
        null,
        `${BOT_NAME} • khu vực tự động`
      );

      return {
        ok: true,
        label: 'Tự động'
      };
    }

    let regions = await getVoiceRegions();

    let region = regions.find(
      item => item.id === regionId
    );

    if (!region) {
      regions = await getVoiceRegions(true);

      region = regions.find(
        item => item.id === regionId
      );
    }

    if (!region) {
      return {
        ok: false
      };
    }

    await channel.setRTCRegion(
      region.id,
      `${BOT_NAME} • đổi khu vực`
    );

    const fresh = await fetchChannel(
      channel.guild,
      channel.id
    );

    if (
      !fresh ||
      fresh.rtcRegion !== region.id
    ) {
      return {
        ok: false
      };
    }

    return {
      ok: true,
      label:
        region.name ||
        region.id
    };
  } catch (error) {
    logError('SET_REGION', error);

    return {
      ok: false
    };
  }
}

function roomLocked(channel) {
  const overwrite =
    channel.permissionOverwrites.cache.get(
      channel.guild.id
    );

  return Boolean(
    overwrite?.deny?.has(
      PermissionFlagsBits.Connect
    )
  );
}

function roomHidden(channel) {
  const overwrite =
    channel.permissionOverwrites.cache.get(
      channel.guild.id
    );

  return Boolean(
    overwrite?.deny?.has(
      PermissionFlagsBits.ViewChannel
    )
  );
}

async function regionLabel(channel) {
  if (!channel.rtcRegion) {
    return 'Tự động';
  }

  const regions = await getVoiceRegions();

  const region = regions.find(
    item =>
      item.id === channel.rtcRegion
  );

  return (
    region?.name ||
    channel.rtcRegion
  );
}

function truncatePanelText(
  value,
  max = 40
) {
  const text = cleanText(
    value,
    max + 20
  );

  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, max - 1)}…`;
}

function panelRule() {
  return '────────────────────────────';
}
async function buildRoomPanel(channel, room, config) {
  const owner = await fetchMember(
    channel.guild,
    room.owner_id
  );

  const ownerDisplayName = owner
    ? memberName(owner)
    : 'Chủ phòng';

  const people = humanMembers(channel).length;

  const limit = channel.userLimit > 0
    ? String(channel.userLimit)
    : '∞';

  const locked = roomLocked(channel);
  const hidden = roomHidden(channel);

  const region = await regionLabel(channel);

  const selectedMemberId = getSelected(
    channel.guild.id,
    channel.id,
    room.owner_id
  );

  let selectedMember = null;
  let selectedBanned = false;

  if (selectedMemberId) {
    selectedMember = await fetchMember(
      channel.guild,
      selectedMemberId
    );

    selectedBanned = await memberIsBanned(
      channel.id,
      selectedMemberId
    );
  }

  const displayName = truncatePanelText(
    config?.display_name || 'Server',
    32
  );

  const titleName = truncatePanelText(
    ownerDisplayName.toUpperCase(),
    24
  );

  const description = [
    `### 🔊  PHÒNG CỦA ${titleName}`,
    panelRule(),
    `👑 Chủ phòng <@${room.owner_id}>`,
    `👥 Thành viên **${people} / ${limit}**`,
    `${locked ? '🔒' : '🔓'} Phòng **${locked ? 'Đang khóa' : 'Đang mở'}**`,
    `${hidden ? '🙈' : '👁'} Hiển thị **${hidden ? 'Đã ẩn' : 'Công khai'}**`,
    `🌐 Khu vực **${region}**`,
    panelRule(),
    `✦ ${BOT_NAME} • ${displayName}`
  ].join('\n');

  const embed = new EmbedBuilder()
    .setDescription(description);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('room_lock')
      .setLabel(locked ? 'Mở' : 'Khóa')
      .setEmoji(locked ? '🔓' : '🔒')
      .setStyle(
        locked
          ? ButtonStyle.Success
          : ButtonStyle.Primary
      ),

    new ButtonBuilder()
      .setCustomId('room_hide')
      .setLabel(hidden ? 'Hiện' : 'Ẩn')
      .setEmoji(hidden ? '👁️' : '🙈')
      .setStyle(
        hidden
          ? ButtonStyle.Success
          : ButtonStyle.Secondary
      ),

    new ButtonBuilder()
      .setCustomId('room_rename')
      .setLabel('Đổi tên')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('room_reset')
      .setLabel('Đặt lại')
      .setEmoji('♻️')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('room_limit')
      .setLabel('Giới hạn')
      .setEmoji('👥')
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId('room_invite')
      .setLabel('Mời')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Success)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('room_transfer')
      .setLabel('Chuyển chủ')
      .setEmoji('👑')
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId('room_deny')
      .setLabel(
        selectedBanned
          ? 'Bỏ cấm'
          : 'Cấm'
      )
      .setEmoji(
        selectedBanned
          ? '✅'
          : '⛔'
      )
      .setStyle(
        selectedBanned
          ? ButtonStyle.Success
          : ButtonStyle.Danger
      ),

    new ButtonBuilder()
      .setCustomId('room_kick')
      .setLabel('Đuổi')
      .setEmoji('👢')
      .setStyle(ButtonStyle.Danger)
  );

  const selectedPlaceholder = selectedMember
    ? `Đã chọn: ${truncatePanelText(
        memberName(selectedMember),
        70
      )}`
    : 'Chọn thành viên...';

  const memberSelect = new UserSelectMenuBuilder()
    .setCustomId('room_member_select')
    .setPlaceholder(selectedPlaceholder)
    .setMinValues(1)
    .setMaxValues(1);

  const row4 = new ActionRowBuilder().addComponents(
    memberSelect
  );

  const regions = await getVoiceRegions();

  const regionOptions = [
    {
      label: 'Tự động',
      value: 'automatic',
      description: 'Discord tự chọn khu vực',
      emoji: '🌐',
      default: !channel.rtcRegion
    }
  ];

  for (const voiceRegion of regions.slice(0, 24)) {
    regionOptions.push({
      label: cleanText(
        voiceRegion.name || voiceRegion.id,
        100
      ),
      value: voiceRegion.id,
      description: cleanText(
        `Khu vực ${voiceRegion.id}`,
        100
      ),
      default:
        channel.rtcRegion === voiceRegion.id
    });
  }

  const regionSelect = new StringSelectMenuBuilder()
    .setCustomId('room_region')
    .setPlaceholder('🌐 Chọn khu vực')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(regionOptions);

  const row5 = new ActionRowBuilder().addComponents(
    regionSelect
  );

  return {
    embeds: [embed],
    components: [
      row1,
      row2,
      row3,
      row4,
      row5
    ],
    allowedMentions: {
      parse: []
    }
  };
}

async function ensureRoomPanel(channelId) {
  return withPanelLock(
    channelId,
    async () => {
      const room = await getRoom(channelId);

      if (!room) {
        return null;
      }

      const guild = client.guilds.cache.get(
        String(room.guild_id)
      );

      if (!guild) {
        return null;
      }

      const channel = await fetchChannel(
        guild,
        room.channel_id
      );

      if (
        !channel ||
        !isVoiceChannel(channel) ||
        !isTextChannel(channel)
      ) {
        return null;
      }

      const config = await getConfig(guild.id);

      const payload = await buildRoomPanel(
        channel,
        room,
        config
      );

      let panel = null;

      if (room.panel_message_id) {
        panel = await fetchMessage(
          channel,
          room.panel_message_id
        );
      }

      if (panel) {
        try {
          await panel.edit(payload);
          return panel;
        } catch (error) {
          logError('PANEL_EDIT', error);
        }
      }

      try {
        panel = await channel.send(payload);

        await setRoomPanelMessage(
          channel.id,
          panel.id
        );

        return panel;
      } catch (error) {
        logError('PANEL_CREATE', error);
        return null;
      }
    }
  );
}

async function refreshRoomPanel(channelId) {
  try {
    return await ensureRoomPanel(channelId);
  } catch (error) {
    logError('PANEL_REFRESH', error);
    return null;
  }
}

async function positionGeneratorFirst(channel) {
  if (!channel?.parentId) {
    return false;
  }

  try {
    await channel.setPosition(0, {
      reason: `${BOT_NAME} • giữ nút tạo phòng trên cùng`
    });

    return true;
  } catch (error) {
    logError('GENERATOR_POSITION', error);
    return false;
  }
}

async function positionRoomBelowGenerator(
  roomChannel,
  generatorChannel
) {
  if (
    !roomChannel ||
    !generatorChannel ||
    roomChannel.parentId !== generatorChannel.parentId
  ) {
    return false;
  }

  try {
    await roomChannel.setPosition(
      generatorChannel.position + 1,
      {
        reason: `${BOT_NAME} • phòng tạm dưới nút tạo phòng`
      }
    );

    return true;
  } catch (error) {
    logError('ROOM_POSITION', error);
    return false;
  }
}

async function createTemporaryRoom(
  guild,
  member,
  generatorChannel
) {
  return withCreateLock(
    guild.id,
    member.id,
    async () => {
      if (cleanupGuilds.has(guild.id)) {
        return null;
      }

      const config = await getConfig(guild.id);

      if (
        !config?.generator_channel_id ||
        String(config.generator_channel_id) !==
          String(generatorChannel.id)
      ) {
        return null;
      }

      const actualVoiceChannelId = voiceChannelIdOf(
        guild,
        member.id
      );

      if (
        String(actualVoiceChannelId || '') !==
        String(generatorChannel.id)
      ) {
        return null;
      }

      const existingRoom = await getOwnedRoom(
        guild.id,
        member.id
      );

      if (existingRoom) {
        const existingChannel = await fetchChannel(
          guild,
          existingRoom.channel_id
        );

        if (isVoiceChannel(existingChannel)) {
          await grantOwner(
            existingChannel,
            member.id
          );

          await refreshRoomPanel(
            existingChannel.id
          );

          const moved = await moveExactMember(
            guild,
            member.id,
            generatorChannel.id,
            existingChannel,
            `${BOT_NAME} • trở lại phòng đang sở hữu`
          );

          if (moved) {
            await addPresence(
              guild.id,
              existingChannel.id,
              member.id
            );

            clearEmptyTimer(existingChannel.id);
          }

          return existingChannel;
        }

        clearRoomRuntime(existingRoom.channel_id);

        await deleteRoomData(
          existingRoom.channel_id
        );
      }

      const category = await fetchChannel(
        guild,
        config.button_category_id
      );

      if (!isCategory(category)) {
        return null;
      }

      const currentMember = await memberInExactRoom(
        guild,
        member.id,
        generatorChannel.id
      );

      if (!currentMember) {
        return null;
      }

      let roomChannel = null;
      let roomRecord = null;

      try {
        const baseName =
          cleanRoomName(memberName(currentMember)) ||
          'Phòng';

        roomChannel = await guild.channels.create({
          name: `${ROOM_PREFIX}${baseName}`,
          type: ChannelType.GuildVoice,
          parent: category.id,
          reason: `${BOT_NAME} • tạo phòng tạm`
        });

        await positionRoomBelowGenerator(
          roomChannel,
          generatorChannel
        );

        roomRecord = await createRoomRecord(
          guild.id,
          roomChannel.id,
          member.id
        );

        const ownerPermissionOk = await grantOwner(
          roomChannel,
          member.id
        );

        if (!ownerPermissionOk) {
          throw new Error(
            'Không thể cấp quyền chủ phòng.'
          );
        }

        const panel = await ensureRoomPanel(
          roomChannel.id
        );

        if (!panel) {
          throw new Error(
            'Không thể tạo panel phòng.'
          );
        }

        const stillInGenerator =
          await memberInExactRoom(
            guild,
            member.id,
            generatorChannel.id
          );

        if (!stillInGenerator) {
          throw new Error(
            'Thành viên đã rời nút tạo phòng.'
          );
        }

        const moved = await moveExactMember(
          guild,
          member.id,
          generatorChannel.id,
          roomChannel,
          `${BOT_NAME} • vào phòng tạm`
        );

        if (!moved) {
          throw new Error(
            'Không thể di chuyển thành viên vào phòng.'
          );
        }

        await addPresence(
          guild.id,
          roomChannel.id,
          member.id
        );

        return roomChannel;
      } catch (error) {
        logError('CREATE_TEMP_ROOM', error);

        if (roomRecord || roomChannel) {
          try {
            await deleteRoomData(
              roomChannel?.id || roomRecord?.channel_id
            );
          } catch (dbError) {
            logError(
              'CREATE_TEMP_ROOM_ROLLBACK_DB',
              dbError
            );
          }
        }

        if (roomChannel) {
          await deleteChannelSafe(
            roomChannel,
            `${BOT_NAME} • rollback tạo phòng lỗi`
          );
        }

        return null;
      }
    }
  );
}

async function handleGeneratorJoin(
  guild,
  member,
  generatorChannelId
) {
  if (
    !guild ||
    !member ||
    member.user?.bot ||
    cleanupGuilds.has(guild.id)
  ) {
    return;
  }

  const config = await getConfig(guild.id);

  if (
    !config?.generator_channel_id ||
    String(config.generator_channel_id) !==
      String(generatorChannelId)
  ) {
    return;
  }

  const generatorChannel = await fetchChannel(
    guild,
    generatorChannelId
  );

  if (!isVoiceChannel(generatorChannel)) {
    return;
  }

  await createTemporaryRoom(
    guild,
    member,
    generatorChannel
  );
}

async function getOwnedRoomFromInteraction(interaction) {
  if (!interaction.inGuild()) {
    return {
      ok: false,
      reason: 'GUILD'
    };
  }

  const room = await getRoom(
    interaction.channelId
  );

  if (!room) {
    return {
      ok: false,
      reason: 'ROOM'
    };
  }

  if (
    String(room.owner_id) !==
    String(interaction.user.id)
  ) {
    return {
      ok: false,
      reason: 'OWNER',
      room
    };
  }

  const channel = await fetchChannel(
    interaction.guild,
    room.channel_id
  );

  if (!isVoiceChannel(channel)) {
    return {
      ok: false,
      reason: 'CHANNEL',
      room
    };
  }

  return {
    ok: true,
    room,
    channel
  };
}

async function requireRoomOwner(interaction) {
  const context = await getOwnedRoomFromInteraction(
    interaction
  );

  if (context.ok) {
    return context;
  }

  if (context.reason === 'OWNER') {
    await tempReply(
      interaction,
      'Chỉ chủ phòng mới dùng được chức năng này.',
      'warning'
    );
  } else {
    await tempReply(
      interaction,
      'Đây không phải phòng Voice HDK đang được quản lý.',
      'warning'
    );
  }

  return null;
}

async function handleRoomMemberSelect(interaction) {
  const context = await requireRoomOwner(
    interaction
  );

  if (!context) {
    return;
  }

  const memberId = interaction.values?.[0];

  if (!isSnowflake(memberId)) {
    return tempReply(
      interaction,
      'Không thể xác định thành viên.',
      'error'
    );
  }

  if (
    String(memberId) ===
    String(interaction.user.id)
  ) {
    clearSelected(
      interaction.guildId,
      context.channel.id,
      interaction.user.id
    );

    await deferComponent(interaction);

    await refreshRoomPanel(
      context.channel.id
    );

    return tempReply(
      interaction,
      'Không cần chọn chính bạn.',
      'warning'
    );
  }

  const member = await fetchMember(
    interaction.guild,
    memberId
  );

  if (!member || member.user?.bot) {
    clearSelected(
      interaction.guildId,
      context.channel.id,
      interaction.user.id
    );

    await deferComponent(interaction);

    await refreshRoomPanel(
      context.channel.id
    );

    return tempReply(
      interaction,
      'Thành viên không hợp lệ.',
      'warning'
    );
  }

  setSelected(
    interaction.guildId,
    context.channel.id,
    interaction.user.id,
    member.id
  );

  await deferComponent(interaction);

  await refreshRoomPanel(
    context.channel.id
  );
}

async function handleRoomLock(interaction) {
  if (useCooldown(interaction, 'lock')) {
    return tempReply(
      interaction,
      'Thao tác quá nhanh.',
      'warning'
    );
  }

  const context = await requireRoomOwner(
    interaction
  );

  if (!context) {
    return;
  }

  await deferComponent(interaction);

  const locked = roomLocked(
    context.channel
  );

  try {
    await context.channel.permissionOverwrites.edit(
      interaction.guild.roles.everyone,
      {
        Connect: locked ? null : false
      },
      {
        reason: `${BOT_NAME} • ${locked ? 'mở' : 'khóa'} phòng`
      }
    );

    await refreshRoomPanel(
      context.channel.id
    );

    return tempReply(
      interaction,
      locked
        ? 'Đã mở phòng.'
        : 'Đã khóa phòng.',
      'success'
    );
  } catch (error) {
    logError('ROOM_LOCK', error);

    return tempReply(
      interaction,
      'Không thể thay đổi trạng thái khóa.',
      'error'
    );
  }
}

async function handleRoomHide(interaction) {
  if (useCooldown(interaction, 'hide')) {
    return tempReply(
      interaction,
      'Thao tác quá nhanh.',
      'warning'
    );
  }

  const context = await requireRoomOwner(
    interaction
  );

  if (!context) {
    return;
  }

  await deferComponent(interaction);

  const hidden = roomHidden(
    context.channel
  );

  try {
    await context.channel.permissionOverwrites.edit(
      interaction.guild.roles.everyone,
      {
        ViewChannel: hidden ? null : false
      },
      {
        reason: `${BOT_NAME} • ${hidden ? 'hiện' : 'ẩn'} phòng`
      }
    );

    await grantOwner(
      context.channel,
      context.room.owner_id
    );

    await refreshRoomPanel(
      context.channel.id
    );

    return tempReply(
      interaction,
      hidden
        ? 'Đã hiện phòng.'
        : 'Đã ẩn phòng.',
      'success'
    );
  } catch (error) {
    logError('ROOM_HIDE', error);

    return tempReply(
      interaction,
      'Không thể thay đổi hiển thị.',
      'error'
    );
  }
}

async function handleRoomRenameButton(interaction) {
  const context = await requireRoomOwner(
    interaction
  );

  if (!context) {
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId('room_rename_modal')
    .setTitle('Đổi tên phòng');

  const input = new TextInputBuilder()
    .setCustomId('room_name')
    .setLabel('Tên mới')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(80)
    .setValue(
      cleanRoomName(context.channel.name)
    );

  modal.addComponents(
    new ActionRowBuilder().addComponents(input)
  );

  await interaction.showModal(modal);
}

async function handleRoomRenameModal(interaction) {
  if (useCooldown(interaction, 'rename')) {
    return tempReply(
      interaction,
      'Thao tác quá nhanh.',
      'warning'
    );
  }

  const context = await requireRoomOwner(
    interaction
  );

  if (!context) {
    return;
  }

  const name = cleanRoomName(
    interaction.fields.getTextInputValue(
      'room_name'
    )
  );

  if (!name) {
    return tempReply(
      interaction,
      'Tên phòng không hợp lệ.',
      'warning'
    );
  }

  await interaction.deferReply({
    ephemeral: true
  });

  try {
    await context.channel.setName(
      `${ROOM_PREFIX}${name}`,
      `${BOT_NAME} • đổi tên phòng`
    );

    await refreshRoomPanel(
      context.channel.id
    );

    await interaction.editReply({
      content: noticeText(
        `Đã đổi tên thành ${name}.`,
        'success'
      )
    });

    scheduleReplyDelete(interaction);
  } catch (error) {
    logError('ROOM_RENAME', error);

    await interaction.editReply({
      content: noticeText(
        'Không thể đổi tên phòng.',
        'error'
      )
    });

    scheduleReplyDelete(interaction);
  }
}

async function handleRoomLimitButton(interaction) {
  const context = await requireRoomOwner(
    interaction
  );

  if (!context) {
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId('room_limit_modal')
    .setTitle('Giới hạn thành viên');

  const input = new TextInputBuilder()
    .setCustomId('room_limit_value')
    .setLabel('0 = không giới hạn • 1 đến 99')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(2)
    .setValue(
      String(context.channel.userLimit || 0)
    );

  modal.addComponents(
    new ActionRowBuilder().addComponents(input)
  );

  await interaction.showModal(modal);
}

async function handleRoomLimitModal(interaction) {
  if (useCooldown(interaction, 'limit')) {
    return tempReply(
      interaction,
      'Thao tác quá nhanh.',
      'warning'
    );
  }

  const context = await requireRoomOwner(
    interaction
  );

  if (!context) {
    return;
  }

  const raw = interaction.fields
    .getTextInputValue('room_limit_value')
    .trim();

  if (!/^\d{1,2}$/.test(raw)) {
    return tempReply(
      interaction,
      'Giới hạn phải từ 0 đến 99.',
      'warning'
    );
  }

  const limit = Number(raw);

  if (
    !Number.isInteger(limit) ||
    limit < 0 ||
    limit > 99
  ) {
    return tempReply(
      interaction,
      'Giới hạn phải từ 0 đến 99.',
      'warning'
    );
  }

  await interaction.deferReply({
    ephemeral: true
  });

  try {
    await context.channel.setUserLimit(
      limit,
      `${BOT_NAME} • giới hạn phòng`
    );

    await refreshRoomPanel(
      context.channel.id
    );

    await interaction.editReply({
      content: noticeText(
        limit === 0
          ? 'Đã bỏ giới hạn thành viên.'
          : `Giới hạn phòng: ${limit} thành viên.`,
        'success'
      )
    });

    scheduleReplyDelete(interaction);
  } catch (error) {
    logError('ROOM_LIMIT', error);

    await interaction.editReply({
      content: noticeText(
        'Không thể thay đổi giới hạn.',
        'error'
      )
    });

    scheduleReplyDelete(interaction);
  }
}

async function handleRoomReset(interaction) {
  if (useCooldown(interaction, 'reset')) {
    return tempReply(
      interaction,
      'Thao tác quá nhanh.',
      'warning'
    );
  }

  const context = await requireRoomOwner(
    interaction
  );

  if (!context) {
    return;
  }

  await deferComponent(interaction);

  try {
    await context.channel.permissionOverwrites.edit(
      interaction.guild.roles.everyone,
      {
        ViewChannel: null,
        Connect: null
      },
      {
        reason: `${BOT_NAME} • đặt lại phòng`
      }
    );

    await context.channel.setUserLimit(
      0,
      `${BOT_NAME} • đặt lại giới hạn`
    );

    await context.channel.setRTCRegion(
      null,
      `${BOT_NAME} • đặt lại khu vực`
    );

    const cleared = await clearMemberOverwrites(
      context.channel,
      [context.room.owner_id]
    );

    if (!cleared) {
      throw new Error(
        'Không thể xóa toàn bộ member overwrite.'
      );
    }

    await clearRoomBans(
      context.channel.id
    );

    await grantOwner(
      context.channel,
      context.room.owner_id
    );

    clearSelected(
      interaction.guildId,
      context.channel.id,
      interaction.user.id
    );

    await refreshRoomPanel(
      context.channel.id
    );

    return tempReply(
      interaction,
      'Đã đặt lại phòng.',
      'success'
    );
  } catch (error) {
    logError('ROOM_RESET', error);

    return tempReply(
      interaction,
      'Không thể đặt lại toàn bộ phòng.',
      'error'
    );
  }
}

async function selectedMemberForAction(
  interaction,
  context
) {
  const memberId = getSelected(
    interaction.guildId,
    context.channel.id,
    interaction.user.id
  );

  if (!memberId) {
    await tempReply(
      interaction,
      'Hãy chọn một thành viên trước.',
      'warning'
    );

    return null;
  }

  const member = await fetchMember(
    interaction.guild,
    memberId
  );

  if (!member || member.user?.bot) {
    clearSelected(
      interaction.guildId,
      context.channel.id,
      interaction.user.id
    );

    await refreshRoomPanel(
      context.channel.id
    );

    await tempReply(
      interaction,
      'Thành viên đã không còn hợp lệ.',
      'warning'
    );

    return null;
  }

  return member;
}

async function clearSelectionAndRefresh(
  interaction,
  context
) {
  clearSelected(
    interaction.guildId,
    context.channel.id,
    interaction.user.id
  );

  await refreshRoomPanel(
    context.channel.id
  );
}

async function handleRoomInvite(interaction) {
  if (useCooldown(interaction, 'invite')) {
    return tempReply(
      interaction,
      'Thao tác quá nhanh.',
      'warning'
    );
  }

  const context = await requireRoomOwner(
    interaction
  );

  if (!context) {
    return;
  }

  const member = await selectedMemberForAction(
    interaction,
    context
  );

  if (!member) {
    return;
  }

  await deferComponent(interaction);

  const invited = await grantInvite(
    context.channel,
    member.id
  );

  if (!invited) {
    await clearSelectionAndRefresh(
      interaction,
      context
    );

    return tempReply(
      interaction,
      'Không thể cấp quyền vào phòng.',
      'error'
    );
  }

  if (
    await memberIsBanned(
      context.channel.id,
      member.id
    )
  ) {
    await removeBan(
      context.channel.id,
      member.id
    );
  }

  await clearSelectionAndRefresh(
    interaction,
    context
  );

  return tempReply(
    interaction,
    `Đã mời ${memberName(member)} vào phòng.`,
    'success'
  );
}

async function handleRoomKick(interaction) {
  if (useCooldown(interaction, 'kick')) {
    return tempReply(
      interaction,
      'Thao tác quá nhanh.',
      'warning'
    );
  }

  const context = await requireRoomOwner(
    interaction
  );

  if (!context) {
    return;
  }

  const member = await selectedMemberForAction(
    interaction,
    context
  );

  if (!member) {
    return;
  }

  if (
    String(member.id) ===
    String(context.room.owner_id)
  ) {
    await clearSelectionAndRefresh(
      interaction,
      context
    );

    return tempReply(
      interaction,
      'Không thể tự đuổi chủ phòng.',
      'warning'
    );
  }

  await deferComponent(interaction);

  const exactMember = await memberInExactRoom(
    interaction.guild,
    member.id,
    context.channel.id
  );

  if (!exactMember) {
    await clearSelectionAndRefresh(
      interaction,
      context
    );

    return tempReply(
      interaction,
      `${memberName(member)} không có mặt trong phòng này.`,
      'warning'
    );
  }

  const result = await disconnectExactMember(
    interaction.guild,
    member.id,
    context.channel.id,
    `${BOT_NAME} • chủ phòng đuổi`
  );

  await clearSelectionAndRefresh(
    interaction,
    context
  );

  if (!result.ok) {
    if (result.reason === 'NOT_IN_ROOM') {
      return tempReply(
        interaction,
        `${memberName(member)} không có mặt trong phòng này.`,
        'warning'
      );
    }

    return tempReply(
      interaction,
      'Không thể đuổi thành viên.',
      'error'
    );
  }

  return tempReply(
    interaction,
    `Đã đuổi ${memberName(member)} khỏi phòng.`,
    'success'
  );
}

async function handleRoomDeny(interaction) {
  if (useCooldown(interaction, 'deny')) {
    return tempReply(
      interaction,
      'Thao tác quá nhanh.',
      'warning'
    );
  }

  const context = await requireRoomOwner(
    interaction
  );

  if (!context) {
    return;
  }

  const member = await selectedMemberForAction(
    interaction,
    context
  );

  if (!member) {
    return;
  }

  if (
    String(member.id) ===
    String(context.room.owner_id)
  ) {
    await clearSelectionAndRefresh(
      interaction,
      context
    );

    return tempReply(
      interaction,
      'Không thể cấm chủ phòng.',
      'warning'
    );
  }

  await deferComponent(interaction);

  const banned = await memberIsBanned(
    context.channel.id,
    member.id
  );

  if (banned) {
    const removed = await deleteMemberPermission(
      context.channel,
      member.id,
      `${BOT_NAME} • bỏ cấm`
    );

    if (!removed) {
      await clearSelectionAndRefresh(
        interaction,
        context
      );

      return tempReply(
        interaction,
        'Không thể bỏ cấm thành viên.',
        'error'
      );
    }

    await removeBan(
      context.channel.id,
      member.id
    );

    await clearSelectionAndRefresh(
      interaction,
      context
    );

    return tempReply(
      interaction,
      `Đã bỏ cấm ${memberName(member)}.`,
      'success'
    );
  }

  const exactMember = await memberInExactRoom(
    interaction.guild,
    member.id,
    context.channel.id
  );

  if (!exactMember) {
    await clearSelectionAndRefresh(
      interaction,
      context
    );

    return tempReply(
      interaction,
      `${memberName(member)} không có mặt trong phòng này.`,
      'warning'
    );
  }

  const denied = await denyMember(
    context.channel,
    member.id
  );

  if (!denied) {
    await clearSelectionAndRefresh(
      interaction,
      context
    );

    return tempReply(
      interaction,
      'Không thể cấm thành viên.',
      'error'
    );
  }

  const disconnectResult =
    await disconnectExactMember(
      interaction.guild,
      member.id,
      context.channel.id,
      `${BOT_NAME} • cấm khỏi phòng`
    );

  if (!disconnectResult.ok) {
    await deleteMemberPermission(
      context.channel,
      member.id,
      `${BOT_NAME} • rollback cấm`
    );

    await clearSelectionAndRefresh(
      interaction,
      context
    );

    if (
      disconnectResult.reason ===
      'NOT_IN_ROOM'
    ) {
      return tempReply(
        interaction,
        `${memberName(member)} không có mặt trong phòng này.`,
        'warning'
      );
    }

    return tempReply(
      interaction,
      'Không thể hoàn tất thao tác cấm.',
      'error'
    );
  }

  await addBan(
    interaction.guildId,
    context.channel.id,
    member.id,
    interaction.user.id
  );

  await clearSelectionAndRefresh(
    interaction,
    context
  );

  return tempReply(
    interaction,
    `Đã cấm ${memberName(member)} khỏi phòng.`,
    'success'
  );
}

async function handleRoomRegion(interaction) {
  if (useCooldown(interaction, 'region')) {
    return tempReply(
      interaction,
      'Thao tác quá nhanh.',
      'warning'
    );
  }

  const context = await requireRoomOwner(
    interaction
  );

  if (!context) {
    return;
  }

  const regionId = interaction.values?.[0];

  if (!regionId) {
    return tempReply(
      interaction,
      'Khu vực không hợp lệ.',
      'warning'
    );
  }

  await deferComponent(interaction);

  const result = await setVoiceRegion(
    context.channel,
    regionId
  );

  await refreshRoomPanel(
    context.channel.id
  );

  if (!result.ok) {
    return tempReply(
      interaction,
      'Không thể thay đổi khu vực.',
      'error'
    );
  }

  return tempReply(
    interaction,
    `Khu vực: ${result.label}.`,
    'success'
  );
}

async function handleRoomTransferButton(interaction) {
  if (useCooldown(interaction, 'transfer')) {
    return tempReply(
      interaction,
      'Thao tác quá nhanh.',
      'warning'
    );
  }

  const context = await requireRoomOwner(
    interaction
  );

  if (!context) {
    return;
  }

  const member = await selectedMemberForAction(
    interaction,
    context
  );

  if (!member) {
    return;
  }

  if (
    String(member.id) ===
    String(context.room.owner_id)
  ) {
    await clearSelectionAndRefresh(
      interaction,
      context
    );

    return tempReply(
      interaction,
      'Bạn đang là chủ phòng.',
      'warning'
    );
  }

  const exactTarget = await memberInExactRoom(
    interaction.guild,
    member.id,
    context.channel.id
  );

  if (!exactTarget) {
    await clearSelectionAndRefresh(
      interaction,
      context
    );

    return tempReply(
      interaction,
      `${memberName(member)} không có mặt trong phòng này.`,
      'warning'
    );
  }

  const targetOwnedRoom = await getOwnedRoom(
    interaction.guildId,
    member.id
  );

  if (
    targetOwnedRoom &&
    String(targetOwnedRoom.channel_id) !==
      String(context.channel.id)
  ) {
    await clearSelectionAndRefresh(
      interaction,
      context
    );

    return tempReply(
      interaction,
      `${memberName(member)} đang sở hữu một phòng khác.`,
      'warning'
    );
  }

  await deferComponent(interaction);

  clearTransfer(context.channel.id);

  const expiresAt = new Date(
    Date.now() + TRANSFER_MS
  );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(
        `transfer_accept:${context.channel.id}`
      )
      .setLabel('Nhận phòng')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId(
        `transfer_decline:${context.channel.id}`
      )
      .setLabel('Từ chối')
      .setEmoji('✖️')
      .setStyle(ButtonStyle.Secondary)
  );

  let message;

  try {
    message = await context.channel.send({
      content: [
        `👑 <@${member.id}>, <@${interaction.user.id}> muốn chuyển quyền chủ phòng cho bạn.`,
        `Yêu cầu hết hạn ${relativeTime(expiresAt)}.`
      ].join('\n'),
      components: [row],
      allowedMentions: {
        users: [
          member.id,
          interaction.user.id
        ]
      }
    });
  } catch (error) {
    logError('TRANSFER_REQUEST_SEND', error);

    await clearSelectionAndRefresh(
      interaction,
      context
    );

    return tempReply(
      interaction,
      'Không thể tạo yêu cầu chuyển chủ.',
      'error'
    );
  }

  const timer = setTimeout(async () => {
    const pending = pendingTransfers.get(
      String(context.channel.id)
    );

    if (
      !pending ||
      pending.messageId !== message.id
    ) {
      return;
    }

    pendingTransfers.delete(
      String(context.channel.id)
    );

    try {
      await message.edit({
        content: '🟠 Yêu cầu chuyển chủ đã hết hạn.',
        components: [],
        allowedMentions: {
          parse: []
        }
      });

      const deleteTimer = setTimeout(() => {
        message.delete().catch(() => {});
      }, NOTICE_MS);

      deleteTimer.unref?.();
    } catch (_) {}
  }, TRANSFER_MS);

  timer.unref?.();

  pendingTransfers.set(
    String(context.channel.id),
    {
      guildId: interaction.guildId,
      channelId: context.channel.id,
      ownerId: interaction.user.id,
      targetId: member.id,
      messageId: message.id,
      expiresAt: expiresAt.getTime(),
      timer
    }
  );

  await clearSelectionAndRefresh(
    interaction,
    context
  );

  return tempReply(
    interaction,
    `Đã gửi yêu cầu chuyển chủ cho ${memberName(member)}.`,
    'success'
  );
}

async function handleTransferAccept(
  interaction,
  channelId
) {
  const pending = pendingTransfers.get(
    String(channelId)
  );

  if (
    !pending ||
    pending.expiresAt <= Date.now()
  ) {
    clearTransfer(channelId);

    return tempReply(
      interaction,
      'Yêu cầu chuyển chủ đã hết hạn.',
      'warning'
    );
  }

  if (
    String(interaction.user.id) !==
    String(pending.targetId)
  ) {
    return tempReply(
      interaction,
      'Yêu cầu này không dành cho bạn.',
      'warning'
    );
  }

  const room = await getRoom(channelId);

  if (
    !room ||
    String(room.owner_id) !==
      String(pending.ownerId)
  ) {
    clearTransfer(channelId);

    return tempReply(
      interaction,
      'Chủ phòng đã thay đổi. Yêu cầu không còn hiệu lực.',
      'warning'
    );
  }

  const channel = await fetchChannel(
    interaction.guild,
    channelId
  );

  if (!isVoiceChannel(channel)) {
    clearTransfer(channelId);

    return tempReply(
      interaction,
      'Phòng không còn tồn tại.',
      'warning'
    );
  }

  const currentOwner = await memberInExactRoom(
    interaction.guild,
    pending.ownerId,
    channel.id
  );

  const target = await memberInExactRoom(
    interaction.guild,
    pending.targetId,
    channel.id
  );

  if (!currentOwner || !target) {
    clearTransfer(channelId);

    try {
      await interaction.update({
        content:
          '🟠 Chuyển chủ đã hủy vì một trong hai người không còn ở phòng.',
        components: [],
        allowedMentions: {
          parse: []
        }
      });

      scheduleReplyDelete(interaction);
    } catch (_) {}

    return;
  }

  const targetOwnedRoom = await getOwnedRoom(
    interaction.guildId,
    target.id
  );

  if (
    targetOwnedRoom &&
    String(targetOwnedRoom.channel_id) !==
      String(channel.id)
  ) {
    clearTransfer(channelId);

    return tempReply(
      interaction,
      'Bạn đang sở hữu một phòng khác.',
      'warning'
    );
  }

  await withRoomLock(
    channel.id,
    async () => {
      const freshRoom = await getRoom(
        channel.id
      );

      if (
        !freshRoom ||
        String(freshRoom.owner_id) !==
          String(pending.ownerId)
      ) {
        throw new Error(
          'TRANSFER_OWNER_CHANGED'
        );
      }

      const ownerCheck = await memberInExactRoom(
        interaction.guild,
        pending.ownerId,
        channel.id
      );

      const targetCheck = await memberInExactRoom(
        interaction.guild,
        pending.targetId,
        channel.id
      );

      if (!ownerCheck || !targetCheck) {
        throw new Error(
          'TRANSFER_MEMBER_LEFT'
        );
      }

      const db = await pool.connect();

      try {
        await db.query('BEGIN');

        await updateRoomOwner(
          channel.id,
          target.id,
          db
        );

        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        db.release();
      }

      const granted = await grantOwner(
        channel,
        target.id
      );

      if (!granted) {
        await updateRoomOwner(
          channel.id,
          pending.ownerId
        );

        throw new Error(
          'TRANSFER_PERMISSION_FAILED'
        );
      }

      await deleteMemberPermission(
        channel,
        pending.ownerId,
        `${BOT_NAME} • thu hồi quyền chủ cũ`
      );

      clearAbsenceTimer(channel.id);
      await deleteAbsence(channel.id);

      clearTransfer(channel.id);

      await refreshRoomPanel(channel.id);
    }
  );

  try {
    await interaction.update({
      content:
        `🟢 <@${pending.targetId}> đã trở thành chủ phòng.`,
      components: [],
      allowedMentions: {
        parse: []
      }
    });

    scheduleReplyDelete(interaction);
  } catch (_) {}
}

async function handleTransferDecline(
  interaction,
  channelId
) {
  const pending = pendingTransfers.get(
    String(channelId)
  );

  if (!pending) {
    return tempReply(
      interaction,
      'Yêu cầu chuyển chủ không còn hiệu lực.',
      'warning'
    );
  }

  if (
    String(interaction.user.id) !==
    String(pending.targetId)
  ) {
    return tempReply(
      interaction,
      'Yêu cầu này không dành cho bạn.',
      'warning'
    );
  }

  clearTransfer(channelId);

  try {
    await interaction.update({
      content:
        `🟠 <@${pending.targetId}> đã từ chối nhận phòng.`,
      components: [],
      allowedMentions: {
        parse: []
      }
    });

    scheduleReplyDelete(interaction);
  } catch (_) {}
}

function userCanSetup(interaction) {
  return Boolean(
    interaction.memberPermissions?.has(
      PermissionsBitField.Flags.ManageGuild
    ) ||
    interaction.memberPermissions?.has(
      PermissionsBitField.Flags.Administrator
    )
  );
}

function setupSessionKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function clearSetupSession(guildId, userId) {
  setupSessions.delete(
    setupSessionKey(
      guildId,
      userId
    )
  );
}

function setSetupSession(
  guildId,
  userId,
  data
) {
  setupSessions.set(
    setupSessionKey(
      guildId,
      userId
    ),
    {
      ...data,
      createdAt: Date.now()
    }
  );
}

function getSetupSession(
  guildId,
  userId
) {
  const key = setupSessionKey(
    guildId,
    userId
  );

  const session = setupSessions.get(key);

  if (!session) {
    return null;
  }

  if (
    Date.now() - session.createdAt >
    10 * 60 * 1000
  ) {
    setupSessions.delete(key);
    return null;
  }

  return session;
}

function buildSetupHome() {
  const embed = new EmbedBuilder()
    .setTitle('⚙️ Voice HDK')
    .setDescription(
      [
        'Thiết lập hệ thống phòng voice tạm.',
        '',
        '• **Cài đặt / Cài đặt lại**',
        '• **Xóa toàn bộ Voice HDK**',
        '',
        'Danh mục bạn chọn sẽ không bị xóa.'
      ].join('\n')
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('setup_install')
      .setLabel('Cài đặt / Cài đặt lại')
      .setEmoji('⚙️')
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId('setup_uninstall')
      .setLabel('Xóa toàn bộ Voice HDK')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger)
  );

  return {
    embeds: [embed],
    components: [row]
  };
}

async function handleSetupCommand(interaction) {
  if (!interaction.inGuild()) {
    return tempReply(
      interaction,
      'Lệnh này chỉ dùng trong Server.',
      'warning'
    );
  }

  if (!userCanSetup(interaction)) {
    return tempReply(
      interaction,
      'Bạn cần quyền Quản lý máy chủ.',
      'warning'
    );
  }

  clearSetupSession(
    interaction.guildId,
    interaction.user.id
  );

  await interaction.reply({
    ...buildSetupHome(),
    ephemeral: true
  });
}

async function handleSetupInstallButton(interaction) {
  if (!userCanSetup(interaction)) {
    return tempReply(
      interaction,
      'Bạn cần quyền Quản lý máy chủ.',
      'warning'
    );
  }

  setSetupSession(
    interaction.guildId,
    interaction.user.id,
    {
      buttonCategoryId: null,
      blogCategoryId: null
    }
  );

  const buttonCategory =
    new ChannelSelectMenuBuilder()
      .setCustomId('setup_button_category')
      .setPlaceholder('Danh mục tạo phòng')
      .setChannelTypes(
        ChannelType.GuildCategory
      )
      .setMinValues(1)
      .setMaxValues(1);

  const blogCategory =
    new ChannelSelectMenuBuilder()
      .setCustomId('setup_blog_category')
      .setPlaceholder('Danh mục nhật ký')
      .setChannelTypes(
        ChannelType.GuildCategory
      )
      .setMinValues(1)
      .setMaxValues(1);

  const continueButton =
    new ButtonBuilder()
      .setCustomId('setup_continue')
      .setLabel('Tiếp tục')
      .setStyle(ButtonStyle.Success);

  const cancelButton =
    new ButtonBuilder()
      .setCustomId('setup_cancel')
      .setLabel('Hủy')
      .setStyle(ButtonStyle.Secondary);

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setTitle('⚙️ Cài đặt Voice HDK')
        .setDescription(
          [
            'Chọn **2 danh mục**:',
            '',
            '🔊 Danh mục chứa `➕ Tạo phòng` và phòng tạm.',
            '📝 Danh mục chứa nhật ký chat và chức năng.',
            '',
            'Sau khi chọn đủ, nhấn **Tiếp tục**.'
          ].join('\n')
        )
    ],
    components: [
      new ActionRowBuilder().addComponents(
        buttonCategory
      ),
      new ActionRowBuilder().addComponents(
        blogCategory
      ),
      new ActionRowBuilder().addComponents(
        continueButton,
        cancelButton
      )
    ]
  });
}

async function handleSetupButtonCategory(interaction) {
  const session = getSetupSession(
    interaction.guildId,
    interaction.user.id
  );

  if (!session) {
    return tempReply(
      interaction,
      'Phiên cài đặt đã hết hạn.',
      'warning'
    );
  }

  session.buttonCategoryId =
    interaction.values[0];

  session.createdAt = Date.now();

  await deferComponent(interaction);
}

async function handleSetupBlogCategory(interaction) {
  const session = getSetupSession(
    interaction.guildId,
    interaction.user.id
  );

  if (!session) {
    return tempReply(
      interaction,
      'Phiên cài đặt đã hết hạn.',
      'warning'
    );
  }

  session.blogCategoryId =
    interaction.values[0];

  session.createdAt = Date.now();

  await deferComponent(interaction);
}

async function handleSetupContinue(interaction) {
  const session = getSetupSession(
    interaction.guildId,
    interaction.user.id
  );

  if (
    !session?.buttonCategoryId ||
    !session?.blogCategoryId
  ) {
    return tempReply(
      interaction,
      'Hãy chọn đủ hai danh mục.',
      'warning'
    );
  }

  const modal = new ModalBuilder()
    .setCustomId('setup_display_name_modal')
    .setTitle('Tên hiển thị');

  const input = new TextInputBuilder()
    .setCustomId('setup_display_name')
    .setLabel('Tên hiển thị ở cuối panel')
    .setPlaceholder('Ví dụ: khung long con')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(80);

  modal.addComponents(
    new ActionRowBuilder().addComponents(input)
  );

  await interaction.showModal(modal);
}

async function handleSetupCancel(interaction) {
  clearSetupSession(
    interaction.guildId,
    interaction.user.id
  );

  await interaction.update({
    content: '🟠 Đã hủy cài đặt.',
    embeds: [],
    components: []
  });

  scheduleReplyDelete(interaction);
}

async function validateSetupCategories(
  guild,
  buttonCategoryId,
  blogCategoryId
) {
  const buttonCategory = await fetchChannel(
    guild,
    buttonCategoryId
  );

  const blogCategory = await fetchChannel(
    guild,
    blogCategoryId
  );

  if (
    !isCategory(buttonCategory) ||
    !isCategory(blogCategory)
  ) {
    return {
      ok: false,
      reason: 'CATEGORY'
    };
  }

  const me =
    guild.members.me ||
    (await guild.members.fetchMe().catch(
      () => null
    ));

  if (!me) {
    return {
      ok: false,
      reason: 'BOT'
    };
  }

  const required = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.EmbedLinks,
    PermissionsBitField.Flags.ReadMessageHistory,
    PermissionsBitField.Flags.ManageChannels,
    PermissionsBitField.Flags.ManageRoles,
    PermissionsBitField.Flags.MoveMembers,
    PermissionsBitField.Flags.Connect
  ];

  for (const category of [
    buttonCategory,
    blogCategory
  ]) {
    const permissions = category.permissionsFor(me);

    if (!permissions) {
      return {
        ok: false,
        reason: 'PERMISSIONS'
      };
    }

    for (const permission of required) {
      if (!permissions.has(permission)) {
        return {
          ok: false,
          reason: 'PERMISSIONS'
        };
      }
    }
  }

  return {
    ok: true,
    buttonCategory,
    blogCategory
  };
}

async function deleteTrackedManagedChannels(
  guild,
  config
) {
  const ids = [
    config?.generator_channel_id,
    config?.chat_log_channel_id,
    config?.action_log_channel_id
  ].filter(Boolean);

  const rooms = await getGuildRooms(guild.id);

  for (const room of rooms) {
    ids.push(room.channel_id);
  }

  const uniqueIds = [...new Set(ids.map(String))];

  for (const id of uniqueIds) {
    const channel = await fetchChannel(
      guild,
      id
    );

    if (!channel) {
      continue;
    }

    const deleted = await deleteChannelSafe(
      channel,
      `${BOT_NAME} • dọn tài nguyên được quản lý`
    );

    if (!deleted) {
      throw new Error(
        `Không thể xóa channel ${id}`
      );
    }
  }
}

async function cleanupManagedGuild(guild) {
  if (cleanupGuilds.has(guild.id)) {
    return false;
  }

  cleanupGuilds.add(guild.id);

  try {
    const config = await getConfig(guild.id);
    const rooms = await getGuildRooms(guild.id);

    for (const room of rooms) {
      clearRoomRuntime(room.channel_id);
    }

    if (config) {
      await deleteTrackedManagedChannels(
        guild,
        config
      );
    } else {
      for (const room of rooms) {
        const channel = await fetchChannel(
          guild,
          room.channel_id
        );

        if (channel) {
          const deleted = await deleteChannelSafe(
            channel,
            `${BOT_NAME} • dọn phòng được quản lý`
          );

          if (!deleted) {
            throw new Error(
              `Không thể xóa phòng ${room.channel_id}`
            );
          }
        }
      }
    }

    const db = await pool.connect();

    try {
      await db.query('BEGIN');

      await deleteGuildVoiceData(
        guild.id,
        db
      );

      await deleteGuildConfig(
        guild.id,
        db
      );

      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      db.release();
    }

    return true;
  } finally {
    cleanupGuilds.delete(guild.id);
  }
}

async function installVoiceHDK(
  guild,
  session,
  displayName
) {
  const validation = await validateSetupCategories(
    guild,
    session.buttonCategoryId,
    session.blogCategoryId
  );

  if (!validation.ok) {
    return {
      ok: false,
      reason: validation.reason
    };
  }

  const oldConfig = await getConfig(guild.id);

  if (oldConfig || (await getGuildRooms(guild.id)).length) {
    const cleaned = await cleanupManagedGuild(guild);

    if (!cleaned) {
      return {
        ok: false,
        reason: 'CLEANUP'
      };
    }
  }

  cleanupGuilds.add(guild.id);

  let generator = null;
  let chatLog = null;
  let actionLog = null;

  try {
    generator = await guild.channels.create({
      name: GENERATOR_NAME,
      type: ChannelType.GuildVoice,
      parent: validation.buttonCategory.id,
      reason: `${BOT_NAME} • tạo nút tạo phòng`
    });

    await positionGeneratorFirst(generator);

    chatLog = await guild.channels.create({
      name: CHAT_LOG_NAME,
      type: ChannelType.GuildText,
      parent: validation.blogCategory.id,
      reason: `${BOT_NAME} • nhật ký chat`
    });

    actionLog = await guild.channels.create({
      name: ACTION_LOG_NAME,
      type: ChannelType.GuildText,
      parent: validation.blogCategory.id,
      reason: `${BOT_NAME} • nhật ký chức năng`
    });

    await saveConfig({
      guildId: guild.id,
      buttonCategoryId:
        validation.buttonCategory.id,
      blogCategoryId:
        validation.blogCategory.id,
      generatorChannelId: generator.id,
      chatLogChannelId: chatLog.id,
      actionLogChannelId: actionLog.id,
      displayName
    });

    return {
      ok: true,
      generator,
      chatLog,
      actionLog
    };
  } catch (error) {
    logError('INSTALL', error);

    for (const channel of [
      actionLog,
      chatLog,
      generator
    ]) {
      if (channel) {
        await deleteChannelSafe(
          channel,
          `${BOT_NAME} • rollback cài đặt`
        );
      }
    }

    return {
      ok: false,
      reason: 'CREATE'
    };
  } finally {
    cleanupGuilds.delete(guild.id);
  }
}

async function handleSetupDisplayNameModal(
  interaction
) {
  const session = getSetupSession(
    interaction.guildId,
    interaction.user.id
  );

  if (!session) {
    return tempReply(
      interaction,
      'Phiên cài đặt đã hết hạn.',
      'warning'
    );
  }

  const displayName = cleanText(
    interaction.fields.getTextInputValue(
      'setup_display_name'
    ),
    80
  );

  if (!displayName) {
    return tempReply(
      interaction,
      'Tên hiển thị không hợp lệ.',
      'warning'
    );
  }

  await interaction.deferReply({
    ephemeral: true
  });

  const result = await installVoiceHDK(
    interaction.guild,
    session,
    displayName
  );

  clearSetupSession(
    interaction.guildId,
    interaction.user.id
  );

  if (!result.ok) {
    const reasonText =
      result.reason === 'PERMISSIONS'
        ? 'Bot thiếu quyền cần thiết trong danh mục đã chọn.'
        : result.reason === 'CATEGORY'
          ? 'Danh mục đã chọn không còn hợp lệ.'
          : 'Không thể hoàn tất cài đặt Voice HDK.';

    await interaction.editReply({
      content: noticeText(
        reasonText,
        'error'
      )
    });

    scheduleReplyDelete(interaction);

    return;
  }

  await interaction.editReply({
    content: [
      '🟢 **Voice HDK đã được cài đặt.**',
      '',
      `🔊 ${GENERATOR_NAME}`,
      `💬 ${CHAT_LOG_NAME}`,
      `⚙️ ${ACTION_LOG_NAME}`,
      '',
      `✦ ${BOT_NAME} • ${displayName}`,
      'Huỳnh Duy Khánh • 0988850044'
    ].join('\n')
  });

  scheduleReplyDelete(
    interaction,
    10_000
  );
}

async function handleSetupUninstallButton(
  interaction
) {
  if (!userCanSetup(interaction)) {
    return tempReply(
      interaction,
      'Bạn cần quyền Quản lý máy chủ.',
      'warning'
    );
  }

  const embed = new EmbedBuilder()
    .setTitle('🗑️ Xóa Voice HDK')
    .setDescription(
      [
        'Hệ thống sẽ xóa:',
        '',
        '• Nút tạo phòng',
        '• Các phòng tạm đang quản lý',
        '• Hai kênh nhật ký',
        '• Dữ liệu phòng trong database',
        '',
        '**Danh mục và kênh không thuộc Voice HDK sẽ được giữ nguyên.**'
      ].join('\n')
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('setup_uninstall_confirm')
      .setLabel('Xác nhận xóa')
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId('setup_uninstall_cancel')
      .setLabel('Hủy')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.update({
    embeds: [embed],
    components: [row]
  });
}

async function handleSetupUninstallConfirm(
  interaction
) {
  if (!userCanSetup(interaction)) {
    return tempReply(
      interaction,
      'Bạn cần quyền Quản lý máy chủ.',
      'warning'
    );
  }

  await interaction.deferUpdate();

  try {
    await cleanupManagedGuild(
      interaction.guild
    );

    await interaction.editReply({
      content:
        '🟢 Đã xóa toàn bộ tài nguyên Voice HDK được quản lý.',
      embeds: [],
      components: []
    });

    scheduleReplyDelete(
      interaction,
      10_000
    );
  } catch (error) {
    logError('UNINSTALL', error);

    await interaction.editReply({
      content:
        '🔴 Không thể xóa hoàn toàn Voice HDK. Hệ thống đã dừng để tránh xóa nhầm tài nguyên.',
      embeds: [],
      components: []
    });

    scheduleReplyDelete(
      interaction,
      10_000
    );
  }
}

async function handleSetupUninstallCancel(
  interaction
) {
  await interaction.update({
    ...buildSetupHome()
  });
}
async function sendActionLog(guild, text) {
  try {
    const config = await getConfig(guild.id);

    if (!config?.action_log_channel_id) {
      return null;
    }

    const channel = await fetchChannel(
      guild,
      config.action_log_channel_id
    );

    if (!isTextChannel(channel)) {
      await clearTrackedConfigChannel(
        guild.id,
        'action_log_channel_id'
      );

      return null;
    }

    return await channel.send({
      content: `\`${vietnamTime()}\` ${text}`,
      allowedMentions: {
        parse: []
      }
    });
  } catch (error) {
    logError('ACTION_LOG', error);
    return null;
  }
}

async function deleteAbsenceNotice(
  guild,
  absence
) {
  if (!absence?.notice_message_id) {
    return;
  }

  const channel = await fetchChannel(
    guild,
    absence.channel_id
  );

  if (!isTextChannel(channel)) {
    return;
  }

  const message = await fetchMessage(
    channel,
    absence.notice_message_id
  );

  if (message) {
    await deleteMessageSafe(message);
  }
}

async function cancelOwnerAbsence(
  guild,
  channelId,
  announce = false
) {
  clearAbsenceTimer(channelId);

  const absence = await getAbsence(channelId);

  if (!absence) {
    return false;
  }

  await deleteAbsenceNotice(
    guild,
    absence
  );

  await deleteAbsence(channelId);

  if (announce) {
    const channel = await fetchChannel(
      guild,
      channelId
    );

    if (isTextChannel(channel)) {
      await sendTempRoomNotice(
        channel,
        'Chủ phòng đã quay lại.',
        'success'
      );
    }
  }

  return true;
}

async function createOwnerAbsenceNotice(
  channel,
  ownerId,
  deadline
) {
  if (!isTextChannel(channel)) {
    return null;
  }

  try {
    return await channel.send({
      content: [
        `🟠 <@${ownerId}> đã rời phòng.`,
        `Nếu chủ phòng không quay lại, quyền chủ sẽ được chuyển ${relativeTime(deadline)}.`
      ].join('\n'),
      allowedMentions: {
        users: [String(ownerId)]
      }
    });
  } catch (error) {
    logError(
      'OWNER_ABSENCE_NOTICE',
      error
    );

    return null;
  }
}

async function getEligibleAutoTransferCandidate(
  guild,
  channel,
  currentOwnerId
) {
  const presence = await getPresence(
    channel.id
  );

  const joinedAtByMember = new Map();

  for (const row of presence) {
    joinedAtByMember.set(
      String(row.member_id),
      new Date(row.joined_at).getTime()
    );
  }

  const candidates = humanMembers(channel)
    .filter(
      member =>
        String(member.id) !==
        String(currentOwnerId)
    )
    .sort((a, b) => {
      const aTime =
        joinedAtByMember.get(
          String(a.id)
        ) || Number.MAX_SAFE_INTEGER;

      const bTime =
        joinedAtByMember.get(
          String(b.id)
        ) || Number.MAX_SAFE_INTEGER;

      return aTime - bTime;
    });

  for (const candidate of candidates) {
    const actual = await memberInExactRoom(
      guild,
      candidate.id,
      channel.id
    );

    if (!actual) {
      continue;
    }

    const ownedRoom = await getOwnedRoom(
      guild.id,
      candidate.id
    );

    if (
      ownedRoom &&
      String(ownedRoom.channel_id) !==
        String(channel.id)
    ) {
      continue;
    }

    return actual;
  }

  return null;
}

async function transferOwnershipAutomatic(
  guild,
  channel,
  room,
  target
) {
  return withRoomLock(
    channel.id,
    async () => {
      const freshRoom = await getRoom(
        channel.id
      );

      if (
        !freshRoom ||
        String(freshRoom.owner_id) !==
          String(room.owner_id)
      ) {
        return false;
      }

      const exactTarget = await memberInExactRoom(
        guild,
        target.id,
        channel.id
      );

      if (!exactTarget) {
        return false;
      }

      const otherRoom = await getOwnedRoom(
        guild.id,
        target.id
      );

      if (
        otherRoom &&
        String(otherRoom.channel_id) !==
          String(channel.id)
      ) {
        return false;
      }

      const oldOwnerId = freshRoom.owner_id;

      const db = await pool.connect();

      try {
        await db.query('BEGIN');

        await updateRoomOwner(
          channel.id,
          target.id,
          db
        );

        await db.query(
          `
            DELETE FROM owner_absence
            WHERE channel_id = $1
          `,
          [String(channel.id)]
        );

        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK').catch(
          () => {}
        );

        throw error;
      } finally {
        db.release();
      }

      const granted = await grantOwner(
        channel,
        target.id
      );

      if (!granted) {
        await updateRoomOwner(
          channel.id,
          oldOwnerId
        );

        return false;
      }

      await deleteMemberPermission(
        channel,
        oldOwnerId,
        `${BOT_NAME} • thu hồi quyền chủ cũ`
      );

      clearAbsenceTimer(
        channel.id
      );

      clearTransfer(
        channel.id
      );

      clearSelected(
        guild.id,
        channel.id,
        oldOwnerId
      );

      await refreshRoomPanel(
        channel.id
      );

      await sendTempRoomNotice(
        channel,
        `${memberName(target)} đã trở thành chủ phòng.`,
        'success'
      );

      await sendActionLog(
        guild,
        `👑 Auto Transfer • ${channel.name} • ${oldOwnerId} → ${target.id}`
      );

      return true;
    }
  );
}

async function executeOwnerAbsenceDeadline(
  guild,
  channelId
) {
  clearAbsenceTimer(
    channelId
  );

  const room = await getRoom(
    channelId
  );

  if (!room) {
    return;
  }

  const channel = await fetchChannel(
    guild,
    channelId
  );

  if (!isVoiceChannel(channel)) {
    await deleteRoomData(
      channelId
    );

    return;
  }

  const absence = await getAbsence(
    channelId
  );

  if (!absence) {
    return;
  }

  if (
    String(absence.owner_id) !==
    String(room.owner_id)
  ) {
    await deleteAbsenceNotice(
      guild,
      absence
    );

    await deleteAbsence(
      channelId
    );

    return;
  }

  const ownerStillInside =
    await memberInExactRoom(
      guild,
      room.owner_id,
      channel.id
    );

  if (ownerStillInside) {
    await cancelOwnerAbsence(
      guild,
      channel.id,
      false
    );

    return;
  }

  const humans =
    humanMembers(channel);

  if (!humans.length) {
    await deleteAbsenceNotice(
      guild,
      absence
    );

    await deleteAbsence(
      channel.id
    );

    scheduleEmptyRoomCheck(
      guild,
      channel.id
    );

    return;
  }

  const candidate =
    await getEligibleAutoTransferCandidate(
      guild,
      channel,
      room.owner_id
    );

  if (!candidate) {
    const retryDeadline =
      new Date(
        Date.now() +
          OWNER_RETRY_MS
      );

    await saveAbsence({
      guildId:
        guild.id,

      channelId:
        channel.id,

      ownerId:
        room.owner_id,

      deadlineAt:
        retryDeadline,

      noticeMessageId:
        absence.notice_message_id
    });

    scheduleOwnerAbsenceTimer(
      guild,
      channel.id,
      retryDeadline
    );

    return;
  }

  await deleteAbsenceNotice(
    guild,
    absence
  );

  const transferred =
    await transferOwnershipAutomatic(
      guild,
      channel,
      room,
      candidate
    );

  if (!transferred) {
    const retryDeadline =
      new Date(
        Date.now() +
          OWNER_RETRY_MS
      );

    await saveAbsence({
      guildId:
        guild.id,

      channelId:
        channel.id,

      ownerId:
        room.owner_id,

      deadlineAt:
        retryDeadline,

      noticeMessageId:
        null
    });

    scheduleOwnerAbsenceTimer(
      guild,
      channel.id,
      retryDeadline
    );
  }
}

function scheduleOwnerAbsenceTimer(
  guild,
  channelId,
  deadline
) {
  clearAbsenceTimer(
    channelId
  );

  const delay =
    Math.max(
      1000,
      new Date(
        deadline
      ).getTime() -
        Date.now()
    );

  const timer =
    setTimeout(
      () => {
        executeOwnerAbsenceDeadline(
          guild,
          channelId
        ).catch(
          error =>
            logError(
              'OWNER_ABSENCE_DEADLINE',
              error
            )
        );
      },
      delay
    );

  timer.unref?.();

  absenceTimers.set(
    String(
      channelId
    ),
    timer
  );
}

async function scheduleOwnerAbsence(
  guild,
  channel,
  room
) {
  const existing =
    await getAbsence(
      channel.id
    );

  if (
    existing &&
    String(existing.owner_id) ===
      String(room.owner_id)
  ) {
    scheduleOwnerAbsenceTimer(
      guild,
      channel.id,
      existing.deadline_at
    );

    return;
  }

  if (existing) {
    await deleteAbsenceNotice(
      guild,
      existing
    );

    await deleteAbsence(
      channel.id
    );
  }

  const deadline =
    new Date(
      Date.now() +
        OWNER_GRACE_MS
    );

  const notice =
    await createOwnerAbsenceNotice(
      channel,
      room.owner_id,
      deadline
    );

  await saveAbsence({
    guildId:
      guild.id,

    channelId:
      channel.id,

    ownerId:
      room.owner_id,

    deadlineAt:
      deadline,

    noticeMessageId:
      notice?.id ||
      null
  });

  scheduleOwnerAbsenceTimer(
    guild,
    channel.id,
    deadline
  );
}

async function deleteManagedEmptyRoom(
  guild,
  channelId
) {
  return withRoomLock(
    channelId,
    async () => {
      const room = await getRoom(
        channelId
      );

      if (!room) {
        return;
      }

      const channel = await fetchChannel(
        guild,
        channelId
      );

      if (!channel) {
        clearRoomRuntime(
          channelId
        );

        await deleteRoomData(
          channelId
        );

        return;
      }

      if (!isVoiceChannel(channel)) {
        return;
      }

      if (
        humanMembers(channel).length >
        0
      ) {
        return;
      }

      const deleted =
        await deleteChannelSafe(
          channel,
          `${BOT_NAME} • phòng trống`
        );

      if (!deleted) {
        return;
      }

      clearRoomRuntime(
        channelId
      );

      await deleteRoomData(
        channelId
      );

      await sendActionLog(
        guild,
        `🗑️ Xóa phòng trống • ${channel.name}`
      );
    }
  );
}

function scheduleEmptyRoomCheck(
  guild,
  channelId
) {
  clearEmptyTimer(
    channelId
  );

  const timer =
    setTimeout(
      () => {
        emptyTimers.delete(
          String(
            channelId
          )
        );

        deleteManagedEmptyRoom(
          guild,
          channelId
        ).catch(
          error =>
            logError(
              'EMPTY_ROOM_DELETE',
              error
            )
        );
      },
      EMPTY_DELETE_MS
    );

  timer.unref?.();

  emptyTimers.set(
    String(
      channelId
    ),
    timer
  );
}

async function handleManagedRoomJoin(
  guild,
  channel,
  member
) {
  if (
    !isHuman(member)
  ) {
    return;
  }

  clearEmptyTimer(
    channel.id
  );

  await addPresence(
    guild.id,
    channel.id,
    member.id
  );

  const room = await getRoom(
    channel.id
  );

  if (!room) {
    return;
  }

  if (
    String(member.id) ===
    String(room.owner_id)
  ) {
    const absence =
      await getAbsence(
        channel.id
      );

    if (absence) {
      await cancelOwnerAbsence(
        guild,
        channel.id,
        true
      );
    }
  }

  await refreshRoomPanel(
    channel.id
  );
}

async function handleManagedRoomLeave(
  guild,
  channel,
  member
) {
  if (
    !isHuman(member)
  ) {
    return;
  }

  await removePresence(
    channel.id,
    member.id
  );

  const room = await getRoom(
    channel.id
  );

  if (!room) {
    return;
  }

  const freshChannel =
    await fetchChannel(
      guild,
      channel.id
    );

  if (
    !freshChannel ||
    !isVoiceChannel(
      freshChannel
    )
  ) {
    return;
  }

  const humans =
    humanMembers(
      freshChannel
    );

  if (!humans.length) {
    clearAbsenceTimer(
      channel.id
    );

    scheduleEmptyRoomCheck(
      guild,
      channel.id
    );

    return;
  }

  if (
    String(member.id) ===
    String(room.owner_id)
  ) {
    const ownerActuallyInside =
      await memberInExactRoom(
        guild,
        room.owner_id,
        channel.id
      );

    if (!ownerActuallyInside) {
      await scheduleOwnerAbsence(
        guild,
        freshChannel,
        room
      );
    }
  }

  await refreshRoomPanel(
    channel.id
  );
}

async function handleManagedVoiceTransition(
  oldState,
  newState
) {
  const guild =
    newState.guild ||
    oldState.guild;

  const member =
    newState.member ||
    oldState.member;

  if (
    !guild ||
    !member ||
    member.user?.bot ||
    cleanupGuilds.has(
      guild.id
    )
  ) {
    return;
  }

  const oldChannelId =
    oldState.channelId;

  const newChannelId =
    newState.channelId;

  if (
    oldChannelId ===
    newChannelId
  ) {
    return;
  }

  if (oldChannelId) {
    const oldRoom =
      await getRoom(
        oldChannelId
      );

    if (oldRoom) {
      const oldChannel =
        oldState.channel ||
        await fetchChannel(
          guild,
          oldChannelId
        );

      if (oldChannel) {
        await handleManagedRoomLeave(
          guild,
          oldChannel,
          member
        );
      }
    }
  }

  if (newChannelId) {
    const config =
      await getConfig(
        guild.id
      );

    if (
      config?.generator_channel_id &&
      String(
        config.generator_channel_id
      ) ===
        String(
          newChannelId
        )
    ) {
      await handleGeneratorJoin(
        guild,
        member,
        newChannelId
      );

      return;
    }

    const newRoom =
      await getRoom(
        newChannelId
      );

    if (newRoom) {
      const newChannel =
        newState.channel ||
        await fetchChannel(
          guild,
          newChannelId
        );

      if (newChannel) {
        await handleManagedRoomJoin(
          guild,
          newChannel,
          member
        );
      }
    }
  }
}

async function handleClaimCommand(
  interaction
) {
  if (!interaction.inGuild()) {
    return tempReply(
      interaction,
      'Lệnh này chỉ dùng trong Server.',
      'warning'
    );
  }

  const member =
    await fetchMember(
      interaction.guild,
      interaction.user.id
    );

  const channelId =
    voiceChannelIdOf(
      interaction.guild,
      interaction.user.id
    );

  if (
    !member ||
    !channelId
  ) {
    return tempReply(
      interaction,
      'Bạn phải ở trong phòng Voice HDK.',
      'warning'
    );
  }

  const room =
    await getRoom(
      channelId
    );

  if (!room) {
    return tempReply(
      interaction,
      'Đây không phải phòng Voice HDK.',
      'warning'
    );
  }

  if (
    String(room.owner_id) ===
    String(member.id)
  ) {
    return tempReply(
      interaction,
      'Bạn đang là chủ phòng.',
      'warning'
    );
  }

  const absence =
    await getAbsence(
      channelId
    );

  if (absence) {
    return tempReply(
      interaction,
      `Chủ phòng đang trong thời gian quay lại ${relativeTime(
        absence.deadline_at
      )}.`,
      'warning'
    );
  }

  const ownerInside =
    await memberInExactRoom(
      interaction.guild,
      room.owner_id,
      channelId
    );

  if (ownerInside) {
    return tempReply(
      interaction,
      'Chủ phòng hiện vẫn đang ở trong phòng.',
      'warning'
    );
  }

  const ownedRoom =
    await getOwnedRoom(
      interaction.guildId,
      member.id
    );

  if (
    ownedRoom &&
    String(
      ownedRoom.channel_id
    ) !==
      String(
        channelId
      )
  ) {
    return tempReply(
      interaction,
      'Bạn đang sở hữu một phòng khác.',
      'warning'
    );
  }

  const channel =
    await fetchChannel(
      interaction.guild,
      channelId
    );

  if (!isVoiceChannel(channel)) {
    return tempReply(
      interaction,
      'Phòng không còn tồn tại.',
      'warning'
    );
  }

  const exactMember =
    await memberInExactRoom(
      interaction.guild,
      member.id,
      channel.id
    );

  if (!exactMember) {
    return tempReply(
      interaction,
      'Bạn không còn ở trong phòng.',
      'warning'
    );
  }

  await interaction.deferReply({
    ephemeral: true
  });

  try {
    await withRoomLock(
      channel.id,
      async () => {
        const freshRoom =
          await getRoom(
            channel.id
          );

        if (!freshRoom) {
          throw new Error(
            'ROOM_NOT_FOUND'
          );
        }

        const freshAbsence =
          await getAbsence(
            channel.id
          );

        if (freshAbsence) {
          throw new Error(
            'OWNER_GRACE'
          );
        }

        const freshOwnerInside =
          await memberInExactRoom(
            interaction.guild,
            freshRoom.owner_id,
            channel.id
          );

        if (freshOwnerInside) {
          throw new Error(
            'OWNER_PRESENT'
          );
        }

        const claimant =
          await memberInExactRoom(
            interaction.guild,
            member.id,
            channel.id
          );

        if (!claimant) {
          throw new Error(
            'CLAIMANT_LEFT'
          );
        }

        const previousOwnerId =
          freshRoom.owner_id;

        await updateRoomOwner(
          channel.id,
          claimant.id
        );

        const granted =
          await grantOwner(
            channel,
            claimant.id
          );

        if (!granted) {
          await updateRoomOwner(
            channel.id,
            previousOwnerId
          );

          throw new Error(
            'CLAIM_PERMISSION'
          );
        }

        await deleteMemberPermission(
          channel,
          previousOwnerId,
          `${BOT_NAME} • thu hồi quyền chủ cũ`
        );

        clearTransfer(
          channel.id
        );

        await refreshRoomPanel(
          channel.id
        );

        await sendActionLog(
          interaction.guild,
          `👑 Claim • ${channel.name} • ${previousOwnerId} → ${claimant.id}`
        );
      }
    );

    await interaction.editReply({
      content:
        '🟢 Bạn đã trở thành chủ phòng.'
    });

    scheduleReplyDelete(
      interaction
    );
  } catch (error) {
    logError(
      'CLAIM',
      error
    );

    let message =
      'Không thể nhận quyền chủ phòng.';

    if (
      error.message ===
      'OWNER_GRACE'
    ) {
      message =
        'Chủ phòng đang trong thời gian quay lại.';
    } else if (
      error.message ===
      'OWNER_PRESENT'
    ) {
      message =
        'Chủ phòng đã quay lại.';
    } else if (
      error.message ===
      'CLAIMANT_LEFT'
    ) {
      message =
        'Bạn không còn ở trong phòng.';
    }

    await interaction.editReply({
      content:
        noticeText(
          message,
          'warning'
        )
    });

    scheduleReplyDelete(
      interaction
    );
  }
}

async function archiveAttachment(
  attachment
) {
  try {
    const response =
      await fetch(
        attachment.url
      );

    if (!response.ok) {
      return {
        ok: false,
        reason:
          `HTTP ${response.status}`
      };
    }

    const declaredLength =
      Number(
        response.headers.get(
          'content-length'
        ) || 0
      );

    const maxBytes =
      8 * 1024 * 1024;

    if (
      declaredLength >
      maxBytes
    ) {
      return {
        ok: false,
        reason:
          'Tệp quá lớn để lưu trực tiếp'
      };
    }

    const arrayBuffer =
      await response.arrayBuffer();

    const buffer =
      Buffer.from(
        arrayBuffer
      );

    if (
      buffer.length >
      maxBytes
    ) {
      return {
        ok: false,
        reason:
          'Tệp quá lớn để lưu trực tiếp'
      };
    }

    return {
      ok: true,
      attachment: {
        attachment:
          buffer,

        name:
          cleanText(
            attachment.name ||
              'attachment',
            100
          )
      }
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error?.message ||
        'Không thể tải tệp'
    };
  }
}

async function getChatLogChannel(
  guild
) {
  const config =
    await getConfig(
      guild.id
    );

  if (
    !config?.chat_log_channel_id
  ) {
    return null;
  }

  const channel =
    await fetchChannel(
      guild,
      config.chat_log_channel_id
    );

  if (!isTextChannel(channel)) {
    await clearTrackedConfigChannel(
      guild.id,
      'chat_log_channel_id'
    );

    return null;
  }

  return channel;
}

function messageAuthorText(
  message
) {
  const display =
    message.member
      ? memberName(
          message.member
        )
      : cleanText(
          message.author?.username ||
            'Unknown',
          50
        );

  return `${display} (${message.author?.id || 'Unknown'})`;
}

async function handleChatLogCreate(
  message
) {
  if (
    !message.guild ||
    message.author?.bot
  ) {
    return;
  }

  const logChannel =
    await getChatLogChannel(
      message.guild
    );

  if (!logChannel) {
    return;
  }

  if (
    String(message.channelId) ===
    String(logChannel.id)
  ) {
    return;
  }

  const lines = [
    `💬 **TIN NHẮN** • \`${vietnamTime(
      message.createdAt
    )}\``,
    `👤 ${messageAuthorText(
      message
    )}`,
    `📍 <#${message.channelId}>`,
    `🔗 ${message.url}`,
    '',
    cleanText(
      message.content ||
        '[Không có nội dung chữ]',
      1800
    )
  ];

  const files = [];
  const failed = [];

  for (
    const attachment
    of message.attachments.values()
  ) {
    const archived =
      await archiveAttachment(
        attachment
      );

    if (archived.ok) {
      files.push(
        archived.attachment
      );
    } else {
      failed.push(
        `${attachment.name || 'attachment'} • ${attachment.url} • ${archived.reason}`
      );
    }
  }

  if (failed.length) {
    lines.push(
      '',
      '⚠️ **Tệp không lưu trực tiếp được:**',
      ...failed
    );
  }

  try {
    await logChannel.send({
      content:
        lines.join('\n').slice(
          0,
          2000
        ),

      files,

      allowedMentions: {
        parse: []
      }
    });
  } catch (error) {
    logError(
      'CHAT_LOG_CREATE',
      error
    );

    if (files.length) {
      try {
        await logChannel.send({
          content:
            [
              ...lines,
              '',
              '⚠️ Discord từ chối bản lưu tệp; giữ lại metadata/URL.'
            ]
              .join('\n')
              .slice(
                0,
                2000
              ),

          allowedMentions: {
            parse: []
          }
        });
      } catch (
        fallbackError
      ) {
        logError(
          'CHAT_LOG_CREATE_FALLBACK',
          fallbackError
        );
      }
    }
  }
}

async function handleChatLogEdit(
  oldMessage,
  newMessage
) {
  if (
    !newMessage.guild ||
    newMessage.author?.bot
  ) {
    return;
  }

  if (oldMessage.partial) {
    try {
      await oldMessage.fetch();
    } catch (_) {}
  }

  if (newMessage.partial) {
    try {
      await newMessage.fetch();
    } catch (_) {}
  }

  const oldContent =
    oldMessage.content ||
    '[Không lấy được nội dung cũ]';

  const newContent =
    newMessage.content ||
    '[Không có nội dung chữ]';

  if (
    oldContent ===
    newContent
  ) {
    return;
  }

  const logChannel =
    await getChatLogChannel(
      newMessage.guild
    );

  if (!logChannel) {
    return;
  }

  if (
    String(newMessage.channelId) ===
    String(logChannel.id)
  ) {
    return;
  }

  const text = [
    `✏️ **CHỈNH SỬA** • \`${vietnamTime()}\``,
    `👤 ${messageAuthorText(
      newMessage
    )}`,
    `📍 <#${newMessage.channelId}>`,
    `🔗 ${newMessage.url}`,
    '',
    '**Trước:**',
    cleanText(
      oldContent,
      700
    ),
    '',
    '**Sau:**',
    cleanText(
      newContent,
      700
    )
  ].join('\n');

  try {
    await logChannel.send({
      content:
        text.slice(
          0,
          2000
        ),

      allowedMentions: {
        parse: []
      }
    });
  } catch (error) {
    logError(
      'CHAT_LOG_EDIT',
      error
    );
  }
}

async function handleChatLogDelete(
  message
) {
  if (
    !message.guild ||
    message.author?.bot
  ) {
    return;
  }

  const logChannel =
    await getChatLogChannel(
      message.guild
    );

  if (!logChannel) {
    return;
  }

  if (
    String(message.channelId) ===
    String(logChannel.id)
  ) {
    return;
  }

  const lines = [
    `🗑️ **XÓA TIN NHẮN** • \`${vietnamTime()}\``,
    `👤 ${messageAuthorText(
      message
    )}`,
    `📍 <#${message.channelId}>`,
    '',
    cleanText(
      message.content ||
        '[Không lấy được nội dung]',
      1400
    )
  ];

  if (
    message.attachments?.size
  ) {
    lines.push(
      '',
      '**Tệp đính kèm:**'
    );

    for (
      const attachment
      of message.attachments.values()
    ) {
      lines.push(
        `${attachment.name || 'attachment'} • ${attachment.url}`
      );
    }
  }

  try {
    await logChannel.send({
      content:
        lines.join('\n').slice(
          0,
          2000
        ),

      allowedMentions: {
        parse: []
      }
    });
  } catch (error) {
    logError(
      'CHAT_LOG_DELETE',
      error
    );
  }
}

async function synchronizeRoomPresence(
  guild,
  channel,
  room
) {
  const currentHumans =
    humanMembers(
      channel
    );

  const currentIds =
    new Set(
      currentHumans.map(
        member =>
          String(
            member.id
          )
      )
    );

  const stored =
    await getPresence(
      channel.id
    );

  for (const row of stored) {
    if (
      !currentIds.has(
        String(
          row.member_id
        )
      )
    ) {
      await removePresence(
        channel.id,
        row.member_id
      );
    }
  }

  const storedIds =
    new Set(
      stored.map(
        row =>
          String(
            row.member_id
          )
      )
    );

  for (
    const member
    of currentHumans
  ) {
    if (
      !storedIds.has(
        String(
          member.id
        )
      )
    ) {
      await addPresence(
        guild.id,
        channel.id,
        member.id
      );
    }
  }

  if (
    currentIds.has(
      String(
        room.owner_id
      )
    )
  ) {
    await cancelOwnerAbsence(
      guild,
      channel.id,
      false
    );

    return;
  }

  if (
    currentHumans.length
  ) {
    const absence =
      await getAbsence(
        channel.id
      );

    if (absence) {
      scheduleOwnerAbsenceTimer(
        guild,
        channel.id,
        absence.deadline_at
      );
    } else {
      await scheduleOwnerAbsence(
        guild,
        channel,
        room
      );
    }
  } else {
    scheduleEmptyRoomCheck(
      guild,
      channel.id
    );
  }
}

async function reconcileGuild(
  guild
) {
  const config =
    await getConfig(
      guild.id
    );

  if (config) {
    if (
      config.generator_channel_id
    ) {
      const generator =
        await fetchChannel(
          guild,
          config.generator_channel_id
        );

      if (
        !generator ||
        !isVoiceChannel(
          generator
        )
      ) {
        await clearTrackedConfigChannel(
          guild.id,
          'generator_channel_id'
        );
      } else {
        await positionGeneratorFirst(
          generator
        );
      }
    }

    if (
      config.chat_log_channel_id
    ) {
      const chatLog =
        await fetchChannel(
          guild,
          config.chat_log_channel_id
        );

      if (
        !isTextChannel(
          chatLog
        )
      ) {
        await clearTrackedConfigChannel(
          guild.id,
          'chat_log_channel_id'
        );
      }
    }

    if (
      config.action_log_channel_id
    ) {
      const actionLog =
        await fetchChannel(
          guild,
          config.action_log_channel_id
        );

      if (
        !isTextChannel(
          actionLog
        )
      ) {
        await clearTrackedConfigChannel(
          guild.id,
          'action_log_channel_id'
        );
      }
    }
  }

  const rooms =
    await getGuildRooms(
      guild.id
    );

  for (const room of rooms) {
    const channel =
      await fetchChannel(
        guild,
        room.channel_id
      );

    if (
      !channel ||
      !isVoiceChannel(
        channel
      )
    ) {
      clearRoomRuntime(
        room.channel_id
      );

      await deleteRoomData(
        room.channel_id
      );

      continue;
    }

    await grantOwner(
      channel,
      room.owner_id
    );

    await ensureRoomPanel(
      channel.id
    );

    await synchronizeRoomPresence(
      guild,
      channel,
      room
    );
  }
}

async function reconcileAllGuilds() {
  for (
    const guild
    of client.guilds.cache.values()
  ) {
    try {
      await reconcileGuild(
        guild
      );
    } catch (error) {
      logError(
        `RECONCILE_${guild.id}`,
        error
      );
    }
  }
}

async function handleTrackedChannelDelete(
  channel
) {
  if (
    !channel?.guild ||
    cleanupGuilds.has(
      channel.guild.id
    )
  ) {
    return;
  }

  const guild =
    channel.guild;

  const room =
    await getRoom(
      channel.id
    );

  if (room) {
    clearRoomRuntime(
      channel.id
    );

    await deleteRoomData(
      channel.id
    );

    return;
  }

  const config =
    await getConfig(
      guild.id
    );

  if (!config) {
    return;
  }

  if (
    String(
      config.generator_channel_id ||
        ''
    ) ===
    String(
      channel.id
    )
  ) {
    await clearTrackedConfigChannel(
      guild.id,
      'generator_channel_id'
    );

    return;
  }

  if (
    String(
      config.chat_log_channel_id ||
        ''
    ) ===
    String(
      channel.id
    )
  ) {
    await clearTrackedConfigChannel(
      guild.id,
      'chat_log_channel_id'
    );

    return;
  }

  if (
    String(
      config.action_log_channel_id ||
        ''
    ) ===
    String(
      channel.id
    )
  ) {
    await clearTrackedConfigChannel(
      guild.id,
      'action_log_channel_id'
    );
  }
}

async function registerGuildCommands(
  guild
) {
  const commands = [
    new SlashCommandBuilder()
      .setName('setup')
      .setDescription(
        'Cài đặt hoặc xóa Voice HDK'
      )
      .setDefaultMemberPermissions(
        PermissionsBitField.Flags.ManageGuild
      ),

    new SlashCommandBuilder()
      .setName('claim')
      .setDescription(
        'Nhận quyền chủ phòng khi đủ điều kiện'
      )
  ].map(
    command =>
      command.toJSON()
  );

  await guild.commands.set(
    commands
  );
}

async function registerAllCommands() {
  for (
    const guild
    of client.guilds.cache.values()
  ) {
    try {
      await registerGuildCommands(
        guild
      );
    } catch (error) {
      logError(
        `COMMANDS_${guild.id}`,
        error
      );
    }
  }
}

async function handleInteraction(
  interaction
) {
  if (
    interaction.isChatInputCommand()
  ) {
    if (
      interaction.commandName ===
      'setup'
    ) {
      return handleSetupCommand(
        interaction
      );
    }

    if (
      interaction.commandName ===
      'claim'
    ) {
      return handleClaimCommand(
        interaction
      );
    }

    return;
  }

  if (
    interaction.isUserSelectMenu() &&
    interaction.customId ===
      'room_member_select'
  ) {
    return handleRoomMemberSelect(
      interaction
    );
  }

  if (
    interaction.isStringSelectMenu()
  ) {
    if (
      interaction.customId ===
      'room_region'
    ) {
      return handleRoomRegion(
        interaction
      );
    }
  }

  if (
    interaction.isChannelSelectMenu()
  ) {
    if (
      interaction.customId ===
      'setup_button_category'
    ) {
      return handleSetupButtonCategory(
        interaction
      );
    }

    if (
      interaction.customId ===
      'setup_blog_category'
    ) {
      return handleSetupBlogCategory(
        interaction
      );
    }
  }

  if (
    interaction.isModalSubmit()
  ) {
    if (
      interaction.customId ===
      'room_rename_modal'
    ) {
      return handleRoomRenameModal(
        interaction
      );
    }

    if (
      interaction.customId ===
      'room_limit_modal'
    ) {
      return handleRoomLimitModal(
        interaction
      );
    }

    if (
      interaction.customId ===
      'setup_display_name_modal'
    ) {
      return handleSetupDisplayNameModal(
        interaction
      );
    }
  }

  if (
    !interaction.isButton()
  ) {
    return;
  }

  const id =
    interaction.customId;

  if (
    id.startsWith(
      'transfer_accept:'
    )
  ) {
    const channelId =
      id.slice(
        'transfer_accept:'.length
      );

    return handleTransferAccept(
      interaction,
      channelId
    );
  }

  if (
    id.startsWith(
      'transfer_decline:'
    )
  ) {
    const channelId =
      id.slice(
        'transfer_decline:'.length
      );

    return handleTransferDecline(
      interaction,
      channelId
    );
  }

  switch (id) {
    case 'room_lock':
      return handleRoomLock(
        interaction
      );

    case 'room_hide':
      return handleRoomHide(
        interaction
      );

    case 'room_rename':
      return handleRoomRenameButton(
        interaction
      );

    case 'room_reset':
      return handleRoomReset(
        interaction
      );

    case 'room_limit':
      return handleRoomLimitButton(
        interaction
      );

    case 'room_invite':
      return handleRoomInvite(
        interaction
      );

    case 'room_transfer':
      return handleRoomTransferButton(
        interaction
      );

    case 'room_deny':
      return handleRoomDeny(
        interaction
      );

    case 'room_kick':
      return handleRoomKick(
        interaction
      );

    case 'setup_install':
      return handleSetupInstallButton(
        interaction
      );

    case 'setup_continue':
      return handleSetupContinue(
        interaction
      );

    case 'setup_cancel':
      return handleSetupCancel(
        interaction
      );

    case 'setup_uninstall':
      return handleSetupUninstallButton(
        interaction
      );

    case 'setup_uninstall_confirm':
      return handleSetupUninstallConfirm(
        interaction
      );

    case 'setup_uninstall_cancel':
      return handleSetupUninstallCancel(
        interaction
      );

    default:
      return;
  }
}

client.on(
  Events.InteractionCreate,
  async interaction => {
    try {
      await handleInteraction(
        interaction
      );
    } catch (error) {
      logError(
        'INTERACTION',
        error
      );

      try {
        await tempReply(
          interaction,
          'Đã xảy ra lỗi khi xử lý thao tác.',
          'error'
        );
      } catch (_) {}
    }
  }
);

client.on(
  Events.VoiceStateUpdate,
  async (
    oldState,
    newState
  ) => {
    try {
      await handleManagedVoiceTransition(
        oldState,
        newState
      );
    } catch (error) {
      logError(
        'VOICE_STATE',
        error
      );
    }
  }
);

client.on(
  Events.ChannelDelete,
  async channel => {
    try {
      await handleTrackedChannelDelete(
        channel
      );
    } catch (error) {
      logError(
        'CHANNEL_DELETE',
        error
      );
    }
  }
);

client.on(
  Events.GuildCreate,
  async guild => {
    try {
      await registerGuildCommands(
        guild
      );

      await reconcileGuild(
        guild
      );
    } catch (error) {
      logError(
        'GUILD_CREATE',
        error
      );
    }
  }
);

client.on(
  Events.MessageCreate,
  async message => {
    try {
      await handleChatLogCreate(
        message
      );
    } catch (error) {
      logError(
        'MESSAGE_CREATE_LOG',
        error
      );
    }
  }
);

client.on(
  Events.MessageUpdate,
  async (
    oldMessage,
    newMessage
  ) => {
    try {
      await handleChatLogEdit(
        oldMessage,
        newMessage
      );
    } catch (error) {
      logError(
        'MESSAGE_UPDATE_LOG',
        error
      );
    }
  }
);

client.on(
  Events.MessageDelete,
  async message => {
    try {
      await handleChatLogDelete(
        message
      );
    } catch (error) {
      logError(
        'MESSAGE_DELETE_LOG',
        error
      );
    }
  }
);

client.once(
  Events.ClientReady,
  async readyClient => {
    console.log(
      `[${BOT_NAME}] Discord ready: ${readyClient.user.tag}`
    );

    try {
      await registerAllCommands();
    } catch (error) {
      logError(
        'REGISTER_COMMANDS',
        error
      );
    }

    try {
      await reconcileAllGuilds();
    } catch (error) {
      logError(
        'STARTUP_RECONCILE',
        error
      );
    }

    console.log(
      `[${BOT_NAME}] v${BOT_VERSION} sẵn sàng.`
    );
  }
);

const healthServer =
  http.createServer(
    (request, response) => {
      if (
        request.url === '/' ||
        request.url === '/health'
      ) {
        const discordReady =
          client.isReady();

        response.writeHead(
          discordReady
            ? 200
            : 503,
          {
            'Content-Type':
              'application/json; charset=utf-8'
          }
        );

        response.end(
          JSON.stringify({
            ok:
              discordReady,
            bot:
              BOT_NAME,
            version:
              BOT_VERSION,
            discord:
              discordReady
                ? 'ready'
                : 'not_ready'
          })
        );

        return;
      }

      response.writeHead(
        404,
        {
          'Content-Type':
            'application/json; charset=utf-8'
        }
      );

      response.end(
        JSON.stringify({
          ok: false,
          error:
            'Not found'
        })
      );
    }
  );

async function verifyDatabase() {
  const result =
    await pool.query(
      'SELECT NOW() AS now'
    );

  if (!result.rows[0]?.now) {
    throw new Error(
      'Không thể xác minh PostgreSQL.'
    );
  }
}

async function shutdown(
  signal
) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(
    `[${BOT_NAME}] Nhận ${signal}, đang dừng...`
  );

  for (
    const timer
    of emptyTimers.values()
  ) {
    clearTimeout(timer);
  }

  for (
    const timer
    of absenceTimers.values()
  ) {
    clearTimeout(timer);
  }

  for (
    const transfer
    of pendingTransfers.values()
  ) {
    if (transfer?.timer) {
      clearTimeout(
        transfer.timer
      );
    }
  }

  try {
    client.destroy();
  } catch (_) {}

  try {
    await pool.end();
  } catch (_) {}

  try {
    healthServer.close();
  } catch (_) {}

  process.exit(0);
}

process.once(
  'SIGTERM',
  () => {
    shutdown(
      'SIGTERM'
    ).catch(
      error => {
        logError(
          'SHUTDOWN',
          error
        );

        process.exit(1);
      }
    );
  }
);

process.once(
  'SIGINT',
  () => {
    shutdown(
      'SIGINT'
    ).catch(
      error => {
        logError(
          'SHUTDOWN',
          error
        );

        process.exit(1);
      }
    );
  }
);

process.on(
  'unhandledRejection',
  error => {
    logError(
      'UNHANDLED_REJECTION',
      error
    );
  }
);

process.on(
  'uncaughtException',
  error => {
    logError(
      'UNCAUGHT_EXCEPTION',
      error
    );
  }
);

async function boot() {
  console.log(
    `[${BOT_NAME}] Khởi động v${BOT_VERSION}...`
  );

  await verifyDatabase();

  console.log(
    `[${BOT_NAME}] PostgreSQL OK.`
  );

  await initDatabase();

  console.log(
    `[${BOT_NAME}] Database schema OK.`
  );

  await new Promise(
    (resolve, reject) => {
      healthServer.once(
        'error',
        reject
      );

      healthServer.listen(
        PORT,
        '0.0.0.0',
        () => {
          healthServer.removeListener(
            'error',
            reject
          );

          console.log(
            `[${BOT_NAME}] Health server: ${PORT}`
          );

          resolve();
        }
      );
    }
  );

  try {
    await client.login(
      TOKEN
    );
  } catch (error) {
    try {
      healthServer.close();
    } catch (_) {}

    throw error;
  }
}

boot().catch(
  async error => {
    logError(
      'BOOT',
      error
    );

    try {
      client.destroy();
    } catch (_) {}

    try {
      await pool.end();
    } catch (_) {}

    try {
      healthServer.close();
    } catch (_) {}

    process.exit(1);
  }
);
