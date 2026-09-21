'use strict';
require('dotenv').config();

const {
  Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField,
  ChannelType
} = require('discord.js');
const { Pool } = require('pg');
const http = require('http');

// ============================================================
// 1) CONFIG
// ============================================================
const TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const PORT = Number(process.env.PORT || 10000);
const DEFAULT_GENERATOR = process.env.GENERATOR_NAME || '➕・Tạo Phòng';
const FIXED_BLOG_NAME = process.env.BLOG_CHANNEL_NAME || '💬│voice-log';
const ROOM_PREFIX = process.env.ROOM_PREFIX || '🔊・';
const APP_COLOR = 0x5865F2;
const COOLDOWN_MS = 1200;
const BOT_NAME = 'Voice HDK';

if (!TOKEN) throw new Error('Thiếu DISCORD_TOKEN.');
if (!DATABASE_URL) throw new Error('Thiếu DATABASE_URL.');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const pool = new Pool({ connectionString: DATABASE_URL });
const cooldowns = new Map();
const panelLocks = new Map();
const pendingTransfers = new Map();
const selectedMembers = new Map(); // channelId -> { ownerId, targetId }
let regionCache = { expires: 0, items: [] };

const REQUIRED_BOT_PERMS = [
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.SendMessages,
  PermissionsBitField.Flags.EmbedLinks,
  PermissionsBitField.Flags.ReadMessageHistory,
  PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.MoveMembers,
  PermissionsBitField.Flags.Connect
];

// Render / UptimeRobot health endpoint. Cố ý rất nhẹ: không gọi DB/Discord API mỗi lần ping.
// UptimeRobot chỉ cần gọi GET https://TEN-SERVICE.onrender.com/health
http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Method Not Allowed');
  }
  const path = String(req.url || '/').split('?')[0];
  if (path !== '/' && path !== '/health') {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: false, message: 'Không tìm thấy đường dẫn.' }));
  }
  const body = JSON.stringify({
    ok: true,
    discord: client.isReady(),
    uptime: Math.floor(process.uptime())
  });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}).listen(PORT, '0.0.0.0', () => {
  console.log(`[HỆ THỐNG] Health check sẵn sàng tại /health · cổng ${PORT}`);
});

// ============================================================
// 2) LOGGING / ERROR BOUNDARIES
// ============================================================
function logError(scope, err, context = {}) {
  const names = {
    DISCORD_CLIENT: 'LỖI DISCORD',
    DISCORD_WARN: 'CẢNH BÁO DISCORD',
    UNHANDLED_REJECTION: 'LỖI PROMISE',
    UNCAUGHT_EXCEPTION: 'LỖI NGHIÊM TRỌNG',
    POSTGRES_POOL: 'LỖI CƠ SỞ DỮ LIỆU',
    STARTUP: 'LỖI KHỞI ĐỘNG',
    LOGIN: 'LỖI ĐĂNG NHẬP',
    INTERACTION: 'LỖI TƯƠNG TÁC',
    VOICE_STATE: 'LỖI VOICE',
    PANEL_CREATE_FAILED: 'LỖI BẢNG ĐIỀU KHIỂN',
    ROOM_DELETE: 'LỖI XÓA PHÒNG'
  };

  const code = err?.code ?? err?.rawError?.code ?? 'KHÔNG_RÕ';
  console.error(
    `[${names[scope] || scope}] mã=${code}`,
    context,
    err?.stack || err
  );
}

client.on(Events.Error, err => logError('DISCORD_CLIENT', err));
client.on(Events.Warn, info => console.warn('[DISCORD_WARN]', info));

process.on('unhandledRejection', err => {
  logError('UNHANDLED_REJECTION', err);
});

process.on('uncaughtException', err => {
  // Không nuốt lỗi lập trình nghiêm trọng; log rõ để Render restart sạch.
  logError('UNCAUGHT_EXCEPTION', err);
});

pool.on('error', err => logError('POSTGRES_POOL', err));

// ============================================================
// 3) DATABASE
// ============================================================
async function initDb() {
  await pool.query('SELECT 1');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS generators (
      guild_id BIGINT PRIMARY KEY,
      category_id BIGINT NOT NULL,
      generator_id BIGINT NOT NULL,
      blog_channel_id BIGINT,
      tracked_text_channel_id BIGINT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      guild_id BIGINT NOT NULL,
      channel_id BIGINT PRIMARY KEY,
      owner_id BIGINT NOT NULL,
      category_id BIGINT NOT NULL,
      control_message_id BIGINT
    )
  `);

  await pool.query(
    'ALTER TABLE rooms ADD COLUMN IF NOT EXISTS control_message_id BIGINT'
  );

  await pool.query(
    'CREATE INDEX IF NOT EXISTS rooms_guild_owner_idx ON rooms(guild_id, owner_id)'
  );

  console.log('[CƠ SỞ DỮ LIỆU] Đã kết nối PostgreSQL thành công.');
}

async function getGenerator(guildId) {
  const { rows } = await pool.query(
    'SELECT * FROM generators WHERE guild_id=$1',
    [guildId]
  );
  return rows[0] || null;
}

async function saveGenerator(guildId, categoryId, generatorId, blogChannelId) {
  await pool.query(
    `INSERT INTO generators(guild_id,category_id,generator_id,blog_channel_id)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(guild_id) DO UPDATE SET
       category_id=EXCLUDED.category_id,
       generator_id=EXCLUDED.generator_id,
       blog_channel_id=EXCLUDED.blog_channel_id`,
    [guildId, categoryId, generatorId, blogChannelId]
  );
}

async function updateTrackedChannel(guildId, channelId) {
  await pool.query(
    'UPDATE generators SET tracked_text_channel_id=$1 WHERE guild_id=$2',
    [channelId, guildId]
  );
}

async function clearTrackedChannel(guildId) {
  await pool.query(
    'UPDATE generators SET tracked_text_channel_id=NULL WHERE guild_id=$1',
    [guildId]
  );
}

async function getRoom(channelId) {
  const { rows } = await pool.query(
    'SELECT * FROM rooms WHERE channel_id=$1',
    [channelId]
  );
  return rows[0] || null;
}

async function getOwnedRoom(guildId, ownerId) {
  const { rows } = await pool.query(
    `SELECT * FROM rooms
     WHERE guild_id=$1 AND owner_id=$2
     ORDER BY channel_id DESC
     LIMIT 1`,
    [guildId, ownerId]
  );
  return rows[0] || null;
}

async function saveRoom(
  guildId,
  channelId,
  ownerId,
  categoryId,
  controlMessageId = null
) {
  await pool.query(
    `INSERT INTO rooms(
       guild_id,
       channel_id,
       owner_id,
       category_id,
       control_message_id
     )
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(channel_id) DO UPDATE SET
       owner_id=EXCLUDED.owner_id,
       category_id=EXCLUDED.category_id,
       control_message_id=COALESCE(
         EXCLUDED.control_message_id,
         rooms.control_message_id
       )`,
    [guildId, channelId, ownerId, categoryId || 0, controlMessageId]
  );
}

async function setControlMessage(channelId, messageId) {
  await pool.query(
    'UPDATE rooms SET control_message_id=$1 WHERE channel_id=$2',
    [messageId, channelId]
  );
}

async function deleteRoomRecord(channelId) {
  selectedMembers.delete(String(channelId));
  pendingTransfers.delete(String(channelId));

  await pool.query(
    'DELETE FROM rooms WHERE channel_id=$1',
    [channelId]
  );
}

// ============================================================
// 4) SMALL HELPERS
// ============================================================
function isSnowflake(v) {
  return /^\d{17,20}$/.test(String(v || ''));
}

function roomState(channel) {
  const everyone = channel.permissionOverwrites.cache.get(
    channel.guild.roles.everyone.id
  );

  return {
    locked: Boolean(
      everyone?.deny.has(PermissionsBitField.Flags.Connect)
    ),
    hidden: Boolean(
      everyone?.deny.has(PermissionsBitField.Flags.ViewChannel)
    )
  };
}

function checkCooldown(userId, action) {
  const key = `${userId}:${action}`;
  const now = Date.now();
  const until = cooldowns.get(key) || 0;

  if (until > now) return false;

  cooldowns.set(key, now + COOLDOWN_MS);
  return true;
}
function vietnamTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).formatToParts(date);

  const get = type => parts.find(p => p.type === type)?.value || '';

  return `${get('hour')}:${get('minute')}:${get('second')} ${get('day')}/${get('month')}/${get('year')}`;
}

function cleanDisplayName(member) {
  return String(
    member?.displayName ||
    member?.user?.globalName ||
    member?.user?.username ||
    'Không rõ'
  )
    .replace(/\r?\n/g, ' ')
    .trim()
    .slice(0, 80);
}

function cleanLogText(text) {
  return String(text || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLinks(content) {
  const matches = String(content || '').match(/https?:\/\/[^\s<>()]+/gi) || [];
  return [...new Set(matches)].slice(0, 20);
}

function selectedKey(channelId) {
  return String(channelId);
}

function getSelectedMember(channelId, ownerId) {
  const value = selectedMembers.get(selectedKey(channelId));

  if (!value) return null;
  if (String(value.ownerId) !== String(ownerId)) return null;

  return value.targetId || null;
}

function setSelectedMember(channelId, ownerId, targetId) {
  selectedMembers.set(selectedKey(channelId), {
    ownerId: String(ownerId),
    targetId: String(targetId)
  });
}

function clearSelectedMember(channelId) {
  selectedMembers.delete(selectedKey(channelId));
}

function isControlPanelMessage(message) {
  if (!message || message.author?.id !== client.user?.id) return false;

  return message.components?.some(row =>
    row.components?.some(component => {
      const id = component.customId || component.custom_id || '';
      return (
        id.startsWith('vc_lock') ||
        id.startsWith('vc_unlock') ||
        id.startsWith('vc_member_select') ||
        id.startsWith('vc_region_select')
      );
    })
  );
}

async function safeReply(interaction, options) {
  const payload = {
    ...options,
    ephemeral: options?.ephemeral ?? true
  };

  try {
    if (interaction.deferred) {
      return await interaction.editReply(payload);
    }

    if (interaction.replied) {
      return await interaction.followUp(payload);
    }

    return await interaction.reply(payload);
  } catch (err) {
    logError('SAFE_REPLY', err, {
      interactionId: interaction?.id,
      customId: interaction?.customId
    });
    return null;
  }
}

async function shortReply(interaction, content, ms = 3500) {
  const message = await safeReply(interaction, {
    content,
    ephemeral: true
  });

  if (!message || ms <= 0) return message;

  setTimeout(async () => {
    try {
      await interaction.deleteReply();
    } catch {
      // Ephemeral có thể đã tự hết hạn / bị thay đổi.
    }
  }, ms).unref?.();

  return message;
}

async function requireVoiceRoom(interaction) {
  const room = await getRoom(interaction.channelId);

  if (!room) {
    await shortReply(
      interaction,
      '❌ Đây không phải phòng Temp Voice đang được quản lý.'
    );
    return null;
  }

  const channel = await interaction.guild.channels
    .fetch(interaction.channelId)
    .catch(() => null);

  if (!channel || channel.type !== ChannelType.GuildVoice) {
    await shortReply(
      interaction,
      '❌ Không tìm thấy phòng thoại.'
    );
    return null;
  }

  const member = await interaction.guild.members
    .fetch(interaction.user.id)
    .catch(() => null);

  if (!member || member.voice.channelId !== channel.id) {
    await shortReply(
      interaction,
      '❌ Bạn phải đang ở trong đúng phòng này để sử dụng điều khiển.'
    );
    return null;
  }

  return { room, channel, member };
}

async function requireOwner(interaction) {
  const data = await requireVoiceRoom(interaction);
  if (!data) return null;

  if (String(data.room.owner_id) !== String(interaction.user.id)) {
    await shortReply(
      interaction,
      '⛔ Chỉ chủ phòng mới sử dụng được chức năng này.'
    );
    return null;
  }

  return data;
}

async function resolveSelectedTarget(interaction, data, options = {}) {
  const targetId = getSelectedMember(
    data.channel.id,
    data.room.owner_id
  );

  if (!targetId || !isSnowflake(targetId)) {
    await shortReply(
      interaction,
      '👤 Hãy chọn thành viên ở ô **Chọn thành viên** trước.'
    );
    return null;
  }

  if (String(targetId) === String(data.room.owner_id)) {
    clearSelectedMember(data.channel.id);

    await shortReply(
      interaction,
      '❌ Không thể chọn chính chủ phòng cho thao tác này.'
    );
    return null;
  }

  if (String(targetId) === String(client.user.id)) {
    clearSelectedMember(data.channel.id);

    await shortReply(
      interaction,
      '❌ Không thể áp dụng thao tác này lên bot.'
    );
    return null;
  }

  const target = await interaction.guild.members
    .fetch(targetId)
    .catch(() => null);

  if (!target) {
    clearSelectedMember(data.channel.id);

    await shortReply(
      interaction,
      '❌ Thành viên đã chọn không còn trong máy chủ.'
    );
    return null;
  }

  if (options.mustBeInRoom && target.voice.channelId !== data.channel.id) {
    clearSelectedMember(data.channel.id);

    await shortReply(
      interaction,
      '❌ Thành viên đã chọn không còn ở trong phòng này.'
    );
    return null;
  }

  return target;
}

async function withPanelLock(channelId, fn) {
  const key = String(channelId);
  const previous = panelLocks.get(key) || Promise.resolve();

  let release;
  const current = new Promise(resolve => {
    release = resolve;
  });

  panelLocks.set(key, current);

  await previous.catch(() => {});

  try {
    return await fn();
  } finally {
    release();

    if (panelLocks.get(key) === current) {
      panelLocks.delete(key);
    }
  }
}

// ============================================================
// 5) PERMISSIONS / ROOM ACTIONS
// ============================================================
function missingBotPermissions(guild, channel = null) {
  const me = guild.members.me;
  if (!me) return REQUIRED_BOT_PERMS;

  const perms = channel
    ? channel.permissionsFor(me)
    : me.permissions;

  return REQUIRED_BOT_PERMS.filter(flag => !perms?.has(flag));
}

function permissionNames(flags) {
  const map = new Map([
    [PermissionsBitField.Flags.ViewChannel, 'Xem kênh'],
    [PermissionsBitField.Flags.SendMessages, 'Gửi tin nhắn'],
    [PermissionsBitField.Flags.EmbedLinks, 'Nhúng liên kết'],
    [PermissionsBitField.Flags.ReadMessageHistory, 'Đọc lịch sử tin nhắn'],
    [PermissionsBitField.Flags.ManageChannels, 'Quản lý kênh'],
    [PermissionsBitField.Flags.ManageRoles, 'Quản lý vai trò/quyền'],
    [PermissionsBitField.Flags.MoveMembers, 'Di chuyển thành viên'],
    [PermissionsBitField.Flags.Connect, 'Kết nối voice']
  ]);

  return flags.map(flag => map.get(flag) || flag.toString());
}

async function ensureBotRoomPermissions(channel) {
  const me = channel.guild.members.me;
  if (!me) throw new Error('Không tìm thấy GuildMember của bot.');

  const guildMissing = missingBotPermissions(channel.guild);

  if (
    guildMissing.includes(PermissionsBitField.Flags.ManageChannels) ||
    guildMissing.includes(PermissionsBitField.Flags.ManageRoles)
  ) {
    throw new Error(
      `Bot thiếu quyền bắt buộc: ${permissionNames(guildMissing).join(', ')}`
    );
  }

  await channel.permissionOverwrites.edit(me.id, {
    ViewChannel: true,
    SendMessages: true,
    EmbedLinks: true,
    ReadMessageHistory: true,
    ManageChannels: true,
    ManageRoles: true,
    MoveMembers: true,
    Connect: true
  });

  const channelMissing = missingBotPermissions(channel.guild, channel);

  if (channelMissing.length) {
    throw new Error(
      `Bot thiếu quyền trong phòng: ${permissionNames(channelMissing).join(', ')}`
    );
  }
}

async function setOwnerAccess(channel, ownerId, enabled = true) {
  if (!isSnowflake(ownerId)) {
    throw new TypeError(`ownerId không hợp lệ: ${ownerId}`);
  }

  if (!enabled) {
    await channel.permissionOverwrites.delete(ownerId).catch(err => {
      logError('OWNER_OVERWRITE_DELETE', err, {
        channelId: channel.id,
        ownerId
      });
    });
    return;
  }

  await channel.permissionOverwrites.edit(ownerId, {
    ViewChannel: true,
    Connect: true,
    Speak: true,
    Stream: true,
    UseVAD: true,
    SendMessages: true,
    ReadMessageHistory: true
  });
}

async function setRoomLocked(channel, locked) {
  await channel.permissionOverwrites.edit(
    channel.guild.roles.everyone.id,
    {
      Connect: locked ? false : null
    }
  );
}

async function setRoomHidden(channel, hidden) {
  await channel.permissionOverwrites.edit(
    channel.guild.roles.everyone.id,
    {
      ViewChannel: hidden ? false : null
    }
  );
}

async function allowMember(channel, member) {
  if (!member?.id || !isSnowflake(member.id)) {
    throw new TypeError('Thành viên cấp quyền không hợp lệ.');
  }

  await channel.permissionOverwrites.edit(member.id, {
    ViewChannel: true,
    Connect: true
  });
}

async function denyMember(channel, member) {
  if (!member?.id || !isSnowflake(member.id)) {
    throw new TypeError('Thành viên cấm không hợp lệ.');
  }

  await channel.permissionOverwrites.edit(member.id, {
    ViewChannel: false,
    Connect: false
  });

  // Chỉ ngắt kết nối nếu người này thực sự đang ở đúng phòng.
  if (member.voice.channelId === channel.id) {
    await member.voice.disconnect(
      `Bị cấm khỏi ${channel.name}`
    );
  }
}

async function kickMember(channel, member) {
  if (!member?.id || !isSnowflake(member.id)) {
    throw new TypeError('Thành viên đuổi không hợp lệ.');
  }

  // Không bao giờ disconnect người đang ở một voice channel khác.
  if (member.voice.channelId !== channel.id) {
    throw new Error('Thành viên không còn ở trong phòng này.');
  }

  await member.voice.disconnect(
    `Bị đuổi khỏi ${channel.name}`
  );
}

async function transferOwner(channel, oldOwnerId, newOwnerId) {
  if (!isSnowflake(oldOwnerId) || !isSnowflake(newOwnerId)) {
    throw new TypeError('ID chủ phòng không hợp lệ.');
  }

  if (String(oldOwnerId) === String(newOwnerId)) {
    throw new Error('Chủ mới trùng với chủ hiện tại.');
  }

  const room = await getRoom(channel.id);

  if (!room) {
    throw new Error('Không tìm thấy dữ liệu phòng.');
  }

  if (String(room.owner_id) !== String(oldOwnerId)) {
    throw new Error('Chủ phòng đã thay đổi trước khi hoàn tất chuyển quyền.');
  }

  const newOwner = await channel.guild.members
    .fetch(newOwnerId)
    .catch(() => null);

  if (!newOwner || newOwner.voice.channelId !== channel.id) {
    throw new Error('Người nhận không còn ở trong phòng.');
  }

  // Cấp quyền cho chủ mới trước.
  await setOwnerAccess(channel, newOwnerId, true);

  // DB chỉ đổi sau khi quyền chủ mới đã được áp dụng thành công.
  await pool.query(
    `UPDATE rooms
     SET owner_id=$1
     WHERE channel_id=$2 AND owner_id=$3`,
    [newOwnerId, channel.id, oldOwnerId]
  );

  const verify = await getRoom(channel.id);

  if (!verify || String(verify.owner_id) !== String(newOwnerId)) {
    await setOwnerAccess(channel, newOwnerId, false).catch(() => {});
    throw new Error('Không thể xác nhận thay đổi chủ phòng trong cơ sở dữ liệu.');
  }

  // Sau khi DB thành công mới thu hồi overwrite riêng của chủ cũ.
  await setOwnerAccess(channel, oldOwnerId, false);

  clearSelectedMember(channel.id);
  pendingTransfers.delete(String(channel.id));

  console.log(
    `[CHUYỂN CHỦ] ${oldOwnerId} → ${newOwnerId} | ${channel.name}`
  );
}

async function resetRoom(channel, ownerId) {
  await setRoomLocked(channel, false);
  await setRoomHidden(channel, false);
  await channel.setUserLimit(0);
  await channel.setRTCRegion(null);

  const protectedIds = new Set([
    String(channel.guild.roles.everyone.id),
    String(ownerId),
    String(client.user.id)
  ]);

  for (const overwrite of channel.permissionOverwrites.cache.values()) {
    if (protectedIds.has(String(overwrite.id))) continue;

    try {
      await channel.permissionOverwrites.delete(overwrite.id);
    } catch (err) {
      logError('RESET_OVERWRITE', err, {
        channelId: channel.id,
        overwriteId: overwrite.id
      });
    }
  }

  await setOwnerAccess(channel, ownerId, true);
  clearSelectedMember(channel.id);
  pendingTransfers.delete(String(channel.id));
}

// ============================================================
// 6) VOICE REGIONS
// ============================================================
async function getVoiceRegions(force = false) {
  const now = Date.now();

  if (!force && regionCache.items.length && regionCache.expires > now) {
    return regionCache.items;
  }

  const regions = await client.fetchVoiceRegions();

  const items = [...regions.values()]
    .filter(region => !region.deprecated)
    .sort((a, b) =>
      String(a.name || a.id).localeCompare(
        String(b.name || b.id),
        'vi'
      )
    );

  regionCache = {
    expires: now + 30 * 60 * 1000,
    items
  };

  return items;
}

function regionLabel(channel, regions = []) {
  if (!channel.rtcRegion) return 'Tự động';

  const found = regions.find(
    region => region.id === channel.rtcRegion
  );

  return found?.name || channel.rtcRegion;
}

// ============================================================
// 7) CONTROL PANEL
// ============================================================
async function buildPanel(channel, room) {
  const owner = await channel.guild.members
    .fetch(room.owner_id)
    .catch(() => null);

  const regions = await getVoiceRegions().catch(() => []);
  const state = roomState(channel);
  const selectedId = getSelectedMember(channel.id, room.owner_id);

  let selected = null;

  if (selectedId) {
    selected = await channel.guild.members
      .fetch(selectedId)
      .catch(() => null);

    if (!selected) {
      clearSelectedMember(channel.id);
    }
  }

  const count = channel.members.filter(
    member => !member.user.bot
  ).size;

  const limit = channel.userLimit > 0
    ? channel.userLimit
    : '∞';

  const ownerName = owner
    ? `<@${owner.id}>`
    : `<@${room.owner_id}>`;

  const embed = new EmbedBuilder()
    .setColor(APP_COLOR)
    .setTitle(channel.name)
    .setDescription([
      `👑 ${ownerName}`,
      `👥 ${count} / ${limit}`,
      `${state.locked ? '🔒 Đã khóa' : '🔓 Đang mở'} · ${state.hidden ? '🙈 Đang ẩn' : '👁 Đang hiển thị'}`,
      `🌐 ${regionLabel(channel, regions)}`
    ].join('\n'));

  if (owner?.user) {
    embed.setThumbnail(
      owner.user.displayAvatarURL({ size: 128 })
    );
  }

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(state.locked ? 'vc_unlock' : 'vc_lock')
      .setLabel(state.locked ? 'Mở phòng' : 'Khóa phòng')
      .setEmoji(state.locked ? '🔓' : '🔒')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId(state.hidden ? 'vc_show' : 'vc_hide')
      .setLabel(state.hidden ? 'Hiện phòng' : 'Ẩn phòng')
      .setEmoji(state.hidden ? '👁' : '🙈')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('vc_rename')
      .setLabel('Đổi tên phòng')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('vc_reset')
      .setLabel('Đặt lại phòng')
      .setEmoji('♻️')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('vc_limit')
      .setLabel('Giới hạn người')
      .setEmoji('👥')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('vc_allow')
      .setLabel('Cấp quyền')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('vc_transfer')
      .setLabel('Chuyển chủ')
      .setEmoji('👑')
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId('vc_deny')
      .setLabel('Cấm thành viên')
      .setEmoji('⛔')
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId('vc_kick')
      .setLabel('Đuổi thành viên')
      .setEmoji('👢')
      .setStyle(ButtonStyle.Danger)
  );

  const memberSelect = new UserSelectMenuBuilder()
    .setCustomId('vc_member_select')
    .setPlaceholder(
      selected
        ? `Thành viên: ${cleanDisplayName(selected)}`
        : 'Chọn thành viên'
    )
    .setMinValues(1)
    .setMaxValues(1);

  const row4 = new ActionRowBuilder().addComponents(memberSelect);

  const regionOptions = [
    {
      label: 'Tự động',
      value: '__AUTO__',
      description: 'Để Discord tự chọn khu vực phù hợp',
      emoji: '🌐',
      default: !channel.rtcRegion
    },
    ...regions.slice(0, 24).map(region => ({
      label: String(region.name || region.id).slice(0, 100),
      value: region.id,
      default: channel.rtcRegion === region.id
    }))
  ];

  const regionSelect = new StringSelectMenuBuilder()
    .setCustomId('vc_region_select')
    .setPlaceholder(
      `Khu vực thoại · ${regionLabel(channel, regions)}`.slice(0, 150)
    )
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(regionOptions);

  const row5 = new ActionRowBuilder().addComponents(regionSelect);

  return {
    embeds: [embed],
    components: [row1, row2, row3, row4, row5]
  };
}
async function refreshPanel(channel, options = {}) {
  if (!channel || channel.type !== ChannelType.GuildVoice) return null;

  return withPanelLock(channel.id, async () => {
    const room = await getRoom(channel.id);
    if (!room) return null;

    await ensureBotRoomPermissions(channel);

    const payload = await buildPanel(channel, room);

    let panelMessage = null;

    // 1. Ưu tiên message ID đã lưu trong DB.
    if (room.control_message_id && isSnowflake(room.control_message_id)) {
      panelMessage = await channel.messages
        .fetch(room.control_message_id)
        .catch(() => null);

      if (panelMessage && !isControlPanelMessage(panelMessage)) {
        panelMessage = null;
      }
    }

    // 2. Nếu DB mất ID / message cũ không còn, tìm panel bot trong lịch sử.
    let recent = null;

    if (!panelMessage || options.cleanupDuplicates) {
      recent = await channel.messages
        .fetch({ limit: 50 })
        .catch(() => null);

      if (recent) {
        const panels = [...recent.values()]
          .filter(isControlPanelMessage)
          .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

        if (!panelMessage && panels.length) {
          panelMessage = panels[0];
        }

        // Tự dọn panel trùng, chỉ xóa panel của chính bot.
        for (const duplicate of panels) {
          if (panelMessage && duplicate.id === panelMessage.id) continue;

          await duplicate.delete().catch(err => {
            logError('PANEL_DUPLICATE_DELETE', err, {
              channelId: channel.id,
              messageId: duplicate.id
            });
          });
        }
      }
    }

    // 3. Cập nhật panel hiện có.
    if (panelMessage) {
      try {
        const edited = await panelMessage.edit(payload);

        if (String(room.control_message_id || '') !== String(edited.id)) {
          await setControlMessage(channel.id, edited.id);
        }

        return edited;
      } catch (err) {
        logError('PANEL_EDIT', err, {
          channelId: channel.id,
          messageId: panelMessage.id
        });

        panelMessage = null;
      }
    }

    // 4. Kiểm tra lại ngay trước khi tạo để chống race-condition panel kép.
    const latest = await channel.messages
      .fetch({ limit: 20 })
      .catch(() => null);

    if (latest) {
      const existing = [...latest.values()]
        .filter(isControlPanelMessage)
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];

      if (existing) {
        const edited = await existing.edit(payload);
        await setControlMessage(channel.id, edited.id);
        return edited;
      }
    }

    // 5. Chỉ khi chắc chắn không có panel mới tạo.
    const created = await channel.send(payload);
    await setControlMessage(channel.id, created.id);

    console.log(
      `[BẢNG ĐIỀU KHIỂN] Đã tạo bảng cho phòng ${channel.name} (${channel.id})`
    );

    return created;
  });
}

async function refreshPanelSafe(channel, cleanupDuplicates = false) {
  try {
    return await refreshPanel(channel, { cleanupDuplicates });
  } catch (err) {
    logError('PANEL_CREATE_FAILED', err, {
      guildId: channel?.guild?.id,
      channelId: channel?.id,
      channelName: channel?.name
    });
    return null;
  }
}

// ============================================================
// 8) MODALS
// ============================================================
function renameModal(channel) {
  const modal = new ModalBuilder()
    .setCustomId('vc_modal_rename')
    .setTitle('Đổi tên phòng');

  const input = new TextInputBuilder()
    .setCustomId('room_name')
    .setLabel('Tên phòng mới')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(90)
    .setValue(
      String(channel.name || '')
        .replace(/^🔊・/, '')
        .slice(0, 90)
    );

  modal.addComponents(
    new ActionRowBuilder().addComponents(input)
  );

  return modal;
}

function limitModal(channel) {
  const modal = new ModalBuilder()
    .setCustomId('vc_modal_limit')
    .setTitle('Giới hạn người');

  const input = new TextInputBuilder()
    .setCustomId('room_limit')
    .setLabel('0 = không giới hạn')
    .setPlaceholder('Ví dụ: 5')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(2)
    .setValue(String(channel.userLimit || 0));

  modal.addComponents(
    new ActionRowBuilder().addComponents(input)
  );

  return modal;
}

function resetConfirmComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('vc_reset_confirm')
        .setLabel('Đặt lại')
        .setEmoji('♻️')
        .setStyle(ButtonStyle.Danger),

      new ButtonBuilder()
        .setCustomId('vc_reset_cancel')
        .setLabel('Hủy')
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

// ============================================================
// 9) TRANSFER REQUEST
// ============================================================
async function createTransferRequest(interaction, data, target) {
  const channelId = String(data.channel.id);

  // Hủy yêu cầu cũ trong RAM nếu có.
  const previous = pendingTransfers.get(channelId);

  if (previous?.messageId) {
    const oldMessage = await data.channel.messages
      .fetch(previous.messageId)
      .catch(() => null);

    if (oldMessage) {
      await oldMessage.edit({
        content: '⌛ Yêu cầu chuyển chủ trước đó đã được thay thế.',
        components: []
      }).catch(() => {});
    }
  }

  const expiresAt = Date.now() + 60_000;

  const request = {
    channelId,
    guildId: String(interaction.guild.id),
    fromOwnerId: String(data.room.owner_id),
    toUserId: String(target.id),
    expiresAt,
    messageId: null
  };

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`vc_transfer_accept:${channelId}`)
      .setLabel('Nhận phòng')
      .setEmoji('👑')
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId(`vc_transfer_decline:${channelId}`)
      .setLabel('Từ chối')
      .setStyle(ButtonStyle.Secondary)
  );

  const message = await data.channel.send({
    content:
      `👑 <@${data.room.owner_id}> muốn chuyển phòng cho <@${target.id}>.\n` +
      `<@${target.id}> hãy xác nhận trong **60 giây**.`,
    components: [row],
    allowedMentions: {
      users: [String(data.room.owner_id), String(target.id)]
    }
  });

  request.messageId = message.id;
  pendingTransfers.set(channelId, request);

  console.log(
    `[CHUYỂN CHỦ] Đang chờ xác nhận: ${data.room.owner_id} → ${target.id} | ${data.channel.name}`
  );

  setTimeout(async () => {
    const current = pendingTransfers.get(channelId);

    if (
      !current ||
      current.messageId !== message.id ||
      current.expiresAt !== expiresAt
    ) {
      return;
    }

    pendingTransfers.delete(channelId);

    const msg = await data.channel.messages
      .fetch(message.id)
      .catch(() => null);

    if (msg) {
      await msg.edit({
        content: '⌛ Yêu cầu chuyển chủ đã hết hạn.',
        components: []
      }).catch(() => {});
    }
  }, 60_500).unref?.();

  return message;
}

// ============================================================
// 10) SETUP / COMMANDS
// ============================================================
const commands = [
  {
    name: 'setup',
    description: 'Thiết lập hệ thống Temp Voice cho máy chủ'
  },
  {
    name: 'panel',
    description: 'Khôi phục bảng điều khiển của phòng hiện tại'
  },
  {
    name: 'doctor',
    description: 'Kiểm tra trạng thái Voice HDK'
  },
  {
    name: 'track-channel',
    description: 'Chọn kênh text cần ghi nhận chat',
    options: [
      {
        name: 'channel',
        description: 'Kênh text cần ghi nhận',
        type: 7,
        required: true
      }
    ]
  },
  {
    name: 'untrack-channel',
    description: 'Tắt ghi nhận kênh text đã chọn'
  }
];

async function registerCommands() {
  await client.application.commands.set(commands);
  console.log('[LỆNH] Đã đồng bộ Slash Commands thành công.');
}

async function setupGuild(interaction) {
  if (
    !interaction.memberPermissions?.has(
      PermissionsBitField.Flags.Administrator
    )
  ) {
    return shortReply(
      interaction,
      '⛔ Chỉ quản trị viên máy chủ mới sử dụng được `/setup`.'
    );
  }

  const missing = missingBotPermissions(interaction.guild);

  if (missing.length) {
    return safeReply(interaction, {
      content:
        '❌ Voice HDK chưa đủ quyền để thiết lập.\n' +
        `Thiếu: **${permissionNames(missing).join(', ')}**`,
      ephemeral: true
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const existing = await getGenerator(interaction.guild.id);

  let category = existing?.category_id
    ? await interaction.guild.channels
        .fetch(existing.category_id)
        .catch(() => null)
    : null;

  if (!category || category.type !== ChannelType.GuildCategory) {
    category = await interaction.guild.channels.create({
      name: 'VOICE HDK',
      type: ChannelType.GuildCategory,
      reason: 'Thiết lập Voice HDK'
    });
  }

  let generator = existing?.generator_id
    ? await interaction.guild.channels
        .fetch(existing.generator_id)
        .catch(() => null)
    : null;

  if (!generator || generator.type !== ChannelType.GuildVoice) {
    generator = await interaction.guild.channels.create({
      name: DEFAULT_GENERATOR,
      type: ChannelType.GuildVoice,
      parent: category.id,
      reason: 'Thiết lập phòng tạo Temp Voice'
    });
  } else if (generator.parentId !== category.id) {
    await generator.setParent(category.id, {
      lockPermissions: false
    });
  }

  let blog = existing?.blog_channel_id
    ? await interaction.guild.channels
        .fetch(existing.blog_channel_id)
        .catch(() => null)
    : null;

  if (!blog || blog.type !== ChannelType.GuildText) {
    blog = interaction.guild.channels.cache.find(
      ch =>
        ch.type === ChannelType.GuildText &&
        ch.name === FIXED_BLOG_NAME
    );

    if (!blog) {
      blog = await interaction.guild.channels.create({
        name: FIXED_BLOG_NAME,
        type: ChannelType.GuildText,
        reason: 'Kênh ghi nhận hoạt động Voice HDK'
      });
    }
  }

  await saveGenerator(
    interaction.guild.id,
    category.id,
    generator.id,
    blog.id
  );

  await interaction.editReply({
    content:
      '✅ Thiết lập Voice HDK hoàn tất.\n' +
      `• Tạo phòng: <#${generator.id}>\n` +
      `• Blog: <#${blog.id}>`
  });

  console.log(
    `[THIẾT LẬP] ${interaction.guild.name} | generator=${generator.id} | blog=${blog.id}`
  );
}

// ============================================================
// 11) CREATE / DELETE TEMP ROOM
// ============================================================
async function createRoom(member, generatorConfig) {
  const guild = member.guild;

  // Không tạo thêm phòng nếu người này đã có phòng còn tồn tại.
  const existingRoom = await getOwnedRoom(guild.id, member.id);

  if (existingRoom) {
    const existingChannel = await guild.channels
      .fetch(existingRoom.channel_id)
      .catch(() => null);

    if (
      existingChannel &&
      existingChannel.type === ChannelType.GuildVoice
    ) {
      if (member.voice.channelId !== existingChannel.id) {
        await member.voice.setChannel(existingChannel).catch(err => {
          logError('MOVE_TO_EXISTING_ROOM', err, {
            guildId: guild.id,
            userId: member.id,
            channelId: existingChannel.id
          });
        });
      }

      await refreshPanelSafe(existingChannel, true);
      return existingChannel;
    }

    await deleteRoomRecord(existingRoom.channel_id);
  }

  const displayName = cleanDisplayName(member)
    .replace(/[\/\\#:@]/g, '')
    .trim()
    .slice(0, 80) || 'Thành viên';

  const roomName = `${ROOM_PREFIX}${displayName}`.slice(0, 100);

  const newChannel = await guild.channels.create({
    name: roomName,
    type: ChannelType.GuildVoice,
    parent: generatorConfig.category_id,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.Connect
        ]
      },
      {
        id: member.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.Connect,
          PermissionsBitField.Flags.Speak,
          PermissionsBitField.Flags.Stream,
          PermissionsBitField.Flags.UseVAD,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory
        ]
      }
    ],
    reason: `Voice HDK tạo phòng cho ${member.user.tag}`
  });

  try {
    await ensureBotRoomPermissions(newChannel);

    await saveRoom(
      guild.id,
      newChannel.id,
      member.id,
      generatorConfig.category_id
    );

    await member.voice.setChannel(newChannel);

    await refreshPanelSafe(newChannel, true);

    console.log(
      `[TẠO PHÒNG] ${cleanDisplayName(member)} → ${newChannel.name} (${newChannel.id})`
    );

    return newChannel;
  } catch (err) {
    logError('CREATE_ROOM', err, {
      guildId: guild.id,
      userId: member.id,
      channelId: newChannel.id
    });

    await deleteRoomRecord(newChannel.id).catch(() => {});
    await newChannel.delete('Hoàn tác vì tạo Temp Voice thất bại')
      .catch(() => {});

    throw err;
  }
}

async function deleteTempRoom(channel) {
  const room = await getRoom(channel.id);
  if (!room) return;

  pendingTransfers.delete(String(channel.id));
  clearSelectedMember(channel.id);

  await deleteRoomRecord(channel.id);

  if (channel.guild.channels.cache.has(channel.id)) {
    await channel.delete('Voice HDK: phòng Temp Voice đã trống')
      .catch(err => {
        logError('ROOM_DELETE', err, {
          guildId: channel.guild.id,
          channelId: channel.id
        });
      });
  }

  console.log(
    `[XÓA PHÒNG] ${channel.name} (${channel.id})`
  );
}

// ============================================================
// 12) BLOG / CHAT LOG
// ============================================================
async function getBlogChannel(guild) {
  const config = await getGenerator(guild.id);
  if (!config?.blog_channel_id) return null;

  const channel = await guild.channels
    .fetch(config.blog_channel_id)
    .catch(() => null);

  return channel?.type === ChannelType.GuildText
    ? channel
    : null;
}

async function downloadAttachmentForLog(attachment) {
  if (!attachment?.url) return null;

  // Tránh giữ file quá lớn trong RAM.
  // Discord vẫn có thể có giới hạn upload thấp hơn tùy máy chủ.
  const maxBytes = 24 * 1024 * 1024;

  if (
    Number.isFinite(attachment.size) &&
    attachment.size > maxBytes
  ) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    12_000
  );

  timeout.unref?.();

  try {
    const response = await fetch(attachment.url, {
      signal: controller.signal
    });

    if (!response.ok) return null;

    const declaredLength = Number(
      response.headers.get('content-length') || 0
    );

    if (declaredLength > maxBytes) return null;

    const arrayBuffer = await response.arrayBuffer();

    if (arrayBuffer.byteLength > maxBytes) return null;

    return {
      attachment: Buffer.from(arrayBuffer),
      name: String(attachment.name || 'tep-dinh-kem')
        .replace(/[\/\\]/g, '_')
        .slice(0, 200)
    };
  } catch (err) {
    logError('ATTACHMENT_DOWNLOAD', err, {
      name: attachment?.name,
      size: attachment?.size
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function buildChatLog(message, action = 'MESSAGE') {
  const member =
    message.member ||
    await message.guild.members
      .fetch(message.author.id)
      .catch(() => null);

  const name = cleanDisplayName(member || {
    user: message.author
  });

  const content = cleanLogText(message.content);
  const links = extractLinks(message.content);
  const attachments = [...message.attachments.values()];
  const timestamp = vietnamTime(
    message.createdAt || new Date()
  );

  let prefix = '';

  if (action === 'DELETE') prefix = '[ĐÃ XÓA] ';
  if (action === 'EDIT') prefix = '[ĐÃ SỬA] ';

  const lines = [];

  if (content) {
    lines.push(
      `${prefix}${name} » "${content.slice(0, 1500)}"`
    );
  } else if (!attachments.length && !links.length) {
    lines.push(`${prefix}${name} » "(không có nội dung chữ)"`);
  } else {
    lines.push(`${prefix}${name} »`);
  }

  if (links.length) {
    lines.push(
      `🔗 Liên kết: ${links.join(' • ').slice(0, 1700)}`
    );
  }

  if (attachments.length) {
    const names = attachments.map(att =>
      String(att.name || 'tệp')
        .replace(/\r?\n/g, ' ')
        .slice(0, 120)
    );

    lines.push(
      `📎 Tệp đính kèm: ${names.join(' • ').slice(0, 1600)}`
    );
  }

  // Ngày giờ luôn ở cuối cùng.
  if (lines.length === 1 && !links.length && !attachments.length) {
    lines[0] += ` • ${timestamp}`;
  } else {
    lines.push(timestamp);
  }

  return {
    text: lines.join('\n').slice(0, 1900),
    attachments
  };
}

async function sendChatLog(message, action = 'MESSAGE') {
  if (!message?.guild || !message?.author) return;
  if (message.author.bot) return;

  const config = await getGenerator(message.guild.id);
  if (!config) return;

  const shouldTrack =
    String(message.channelId) === String(config.tracked_text_channel_id) ||
    Boolean(await getRoom(message.channelId));

  if (!shouldTrack) return;

  const blog = await getBlogChannel(message.guild);
  if (!blog) return;

  // Không log chính kênh blog để tránh vòng lặp.
  if (String(message.channelId) === String(blog.id)) return;

  const built = await buildChatLog(message, action);
  const files = [];

  for (const attachment of built.attachments.slice(0, 10)) {
    const downloaded = await downloadAttachmentForLog(attachment);

    if (downloaded) {
      files.push(downloaded);
    }
  }

  try {
    await blog.send({
      content: built.text,
      files,
      allowedMentions: {
        parse: []
      }
    });
  } catch (err) {
    logError('BLOG_SEND_WITH_FILES', err, {
      guildId: message.guild.id,
      channelId: message.channelId,
      messageId: message.id
    });

    // Nếu Discord từ chối file, vẫn giữ bằng chứng metadata + URL.
    const fallbackUrls = built.attachments
      .map(att => att.url)
      .filter(Boolean)
      .slice(0, 10);

    const fallback = [
      built.text,
      fallbackUrls.length
        ? `🔗 Tệp gốc: ${fallbackUrls.join(' • ')}`
        : '',
      files.length < built.attachments.length
        ? '⚠️ Một hoặc nhiều tệp không thể sao lưu trực tiếp.'
        : ''
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 1950);

    await blog.send({
      content: fallback,
      allowedMentions: {
        parse: []
      }
    }).catch(fallbackErr => {
      logError('BLOG_SEND_FALLBACK', fallbackErr, {
        guildId: message.guild.id,
        channelId: message.channelId,
        messageId: message.id
      });
    });
  }
}
// ============================================================
// 13) MESSAGE EVENTS
// ============================================================
client.on(Events.MessageCreate, async message => {
  try {
    await sendChatLog(message, 'MESSAGE');
  } catch (err) {
    logError('MESSAGE_CREATE', err, {
      guildId: message?.guild?.id,
      channelId: message?.channelId,
      messageId: message?.id
    });
  }
});

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  try {
    if (newMessage.partial) {
      newMessage = await newMessage.fetch().catch(() => newMessage);
    }

    if (!newMessage?.guild || !newMessage?.author) return;
    if (newMessage.author.bot) return;

    const oldContent = cleanLogText(oldMessage?.content);
    const newContent = cleanLogText(newMessage?.content);

    const oldAttachments = oldMessage?.attachments?.size || 0;
    const newAttachments = newMessage?.attachments?.size || 0;

    if (
      oldContent === newContent &&
      oldAttachments === newAttachments
    ) {
      return;
    }

    const config = await getGenerator(newMessage.guild.id);
    if (!config) return;

    const shouldTrack =
      String(newMessage.channelId) ===
        String(config.tracked_text_channel_id) ||
      Boolean(await getRoom(newMessage.channelId));

    if (!shouldTrack) return;

    const blog = await getBlogChannel(newMessage.guild);
    if (!blog) return;

    if (String(newMessage.channelId) === String(blog.id)) return;

    const member =
      newMessage.member ||
      await newMessage.guild.members
        .fetch(newMessage.author.id)
        .catch(() => null);

    const name = cleanDisplayName(
      member || { user: newMessage.author }
    );

    const before = oldContent || '(không có nội dung chữ)';
    const after = newContent || '(không có nội dung chữ)';

    const time = vietnamTime(new Date());

    let text =
      `[ĐÃ SỬA] ${name} » ` +
      `"${before.slice(0, 700)}" → "${after.slice(0, 700)}"`;

    const links = extractLinks(newMessage.content);

    if (links.length) {
      text += `\n🔗 Liên kết: ${links.join(' • ').slice(0, 1200)}`;
    }

    if (newMessage.attachments?.size) {
      const attachmentNames = [...newMessage.attachments.values()]
        .map(att =>
          String(att.name || 'tệp')
            .replace(/\r?\n/g, ' ')
            .slice(0, 100)
        )
        .join(' • ');

      text += `\n📎 Tệp đính kèm: ${attachmentNames.slice(0, 1200)}`;
    }

    text += `\n${time}`;

    const files = [];

    if (newMessage.attachments?.size) {
      for (
        const attachment of
        [...newMessage.attachments.values()].slice(0, 10)
      ) {
        const downloaded =
          await downloadAttachmentForLog(attachment);

        if (downloaded) files.push(downloaded);
      }
    }

    await blog.send({
      content: text.slice(0, 1950),
      files,
      allowedMentions: {
        parse: []
      }
    }).catch(async err => {
      logError('MESSAGE_UPDATE_LOG', err, {
        guildId: newMessage.guild.id,
        messageId: newMessage.id
      });

      await blog.send({
        content: text.slice(0, 1950),
        allowedMentions: {
          parse: []
        }
      }).catch(() => {});
    });
  } catch (err) {
    logError('MESSAGE_UPDATE', err, {
      guildId: newMessage?.guild?.id,
      channelId: newMessage?.channelId,
      messageId: newMessage?.id
    });
  }
});

client.on(Events.MessageDelete, async message => {
  try {
    if (!message?.guild) return;

    if (message.partial) {
      // Tin đã xóa không phải lúc nào cũng fetch lại được.
      // Nếu cache còn dữ liệu thì tiếp tục ghi log.
      if (!message.author) return;
    }

    if (!message.author || message.author.bot) return;

    await sendChatLog(message, 'DELETE');
  } catch (err) {
    logError('MESSAGE_DELETE', err, {
      guildId: message?.guild?.id,
      channelId: message?.channelId,
      messageId: message?.id
    });
  }
});

// ============================================================
// 14) VOICE STATE EVENTS
// ============================================================
client.on(
  Events.VoiceStateUpdate,
  async (oldState, newState) => {
    try {
      const guild = newState.guild || oldState.guild;
      if (!guild) return;

      const config = await getGenerator(guild.id);
      if (!config) return;

      const member = newState.member || oldState.member;
      if (!member || member.user.bot) return;

      // Thành viên vừa vào phòng "Tạo Phòng".
      if (
        newState.channelId &&
        String(newState.channelId) ===
          String(config.generator_id) &&
        String(oldState.channelId) !==
          String(config.generator_id)
      ) {
        try {
          await createRoom(member, config);
        } catch (err) {
          logError('VOICE_CREATE_ROOM', err, {
            guildId: guild.id,
            userId: member.id
          });

          // Nếu tạo thất bại, cố gắng đưa user ra khỏi generator.
          if (
            member.voice.channelId ===
            String(config.generator_id)
          ) {
            await member.voice
              .disconnect('Không thể tạo Temp Voice')
              .catch(() => {});
          }
        }
      }

      // Phòng cũ: cập nhật panel hoặc xóa nếu trống.
      if (
        oldState.channelId &&
        String(oldState.channelId) !==
          String(config.generator_id)
      ) {
        const oldRoom = await getRoom(oldState.channelId);

        if (oldRoom) {
          const oldChannel =
            oldState.channel ||
            await guild.channels
              .fetch(oldState.channelId)
              .catch(() => null);

          if (
            oldChannel &&
            oldChannel.type === ChannelType.GuildVoice
          ) {
            const humans = oldChannel.members.filter(
              m => !m.user.bot
            );

            if (humans.size === 0) {
              await deleteTempRoom(oldChannel);
            } else {
              const selected =
                selectedMembers.get(
                  selectedKey(oldChannel.id)
                );

              if (
                selected &&
                String(selected.targetId) === String(member.id) &&
                member.voice.channelId !== oldChannel.id
              ) {
                clearSelectedMember(oldChannel.id);
              }

              await refreshPanelSafe(oldChannel);
            }
          }
        }
      }

      // Phòng mới: cập nhật số người trên panel.
      if (
        newState.channelId &&
        String(newState.channelId) !==
          String(config.generator_id)
      ) {
        const newRoom = await getRoom(newState.channelId);

        if (newRoom) {
          const newChannel =
            newState.channel ||
            await guild.channels
              .fetch(newState.channelId)
              .catch(() => null);

          if (
            newChannel &&
            newChannel.type === ChannelType.GuildVoice
          ) {
            await refreshPanelSafe(newChannel);
          }
        }
      }
    } catch (err) {
      logError('VOICE_STATE', err, {
        guildId:
          newState?.guild?.id ||
          oldState?.guild?.id,
        userId:
          newState?.id ||
          oldState?.id,
        oldChannelId: oldState?.channelId,
        newChannelId: newState?.channelId
      });
    }
  }
);

// ============================================================
// 15) BUTTON / SELECT / MODAL HANDLERS
// ============================================================
async function handleMemberSelect(interaction) {
  const data = await requireOwner(interaction);
  if (!data) return;

  if (!checkCooldown(interaction.user.id, 'member_select')) {
    return shortReply(
      interaction,
      '⏳ Thao tác quá nhanh, thử lại sau một chút.'
    );
  }

  const targetId = interaction.values?.[0];

  if (!targetId || !isSnowflake(targetId)) {
    return shortReply(
      interaction,
      '❌ Thành viên được chọn không hợp lệ.'
    );
  }

  if (String(targetId) === String(interaction.user.id)) {
    return shortReply(
      interaction,
      '❌ Bạn không cần chọn chính mình.'
    );
  }

  if (String(targetId) === String(client.user.id)) {
    return shortReply(
      interaction,
      '❌ Không thể chọn bot.'
    );
  }

  const target = await interaction.guild.members
    .fetch(targetId)
    .catch(() => null);

  if (!target) {
    return shortReply(
      interaction,
      '❌ Không tìm thấy thành viên này trong máy chủ.'
    );
  }

  setSelectedMember(
    data.channel.id,
    data.room.owner_id,
    target.id
  );

  await interaction.deferUpdate();

  await refreshPanelSafe(data.channel);

  await interaction.followUp({
    content: `👤 Đã chọn **${cleanDisplayName(target)}**.`,
    ephemeral: true
  }).catch(() => {});
}

async function handleRegionSelect(interaction) {
  const data = await requireOwner(interaction);
  if (!data) return;

  if (!checkCooldown(interaction.user.id, 'region')) {
    return shortReply(
      interaction,
      '⏳ Bạn đổi khu vực quá nhanh.'
    );
  }

  const value = interaction.values?.[0];

  if (!value) {
    return shortReply(
      interaction,
      '❌ Khu vực thoại không hợp lệ.'
    );
  }

  await interaction.deferUpdate();

  try {
    if (value === '__AUTO__') {
      await data.channel.setRTCRegion(null);
    } else {
      const regions = await getVoiceRegions(true);

      if (!regions.some(region => region.id === value)) {
        throw new Error(
          `Khu vực thoại "${value}" không còn khả dụng.`
        );
      }

      await data.channel.setRTCRegion(value);
    }

    const verified = await interaction.guild.channels
      .fetch(data.channel.id)
      .catch(() => null);

    if (!verified) {
      throw new Error(
        'Không thể xác minh phòng sau khi đổi khu vực.'
      );
    }

    if (
      value === '__AUTO__' &&
      verified.rtcRegion !== null
    ) {
      throw new Error(
        'Discord chưa áp dụng chế độ khu vực tự động.'
      );
    }

    if (
      value !== '__AUTO__' &&
      verified.rtcRegion !== value
    ) {
      throw new Error(
        'Discord chưa áp dụng khu vực đã chọn.'
      );
    }

    await refreshPanelSafe(verified);

    await interaction.followUp({
      content:
        value === '__AUTO__'
          ? '🌐 Đã chuyển khu vực thoại về **Tự động**.'
          : `🌐 Đã đổi khu vực thoại thành **${value}**.`,
      ephemeral: true
    }).catch(() => {});
  } catch (err) {
    logError('REGION_CHANGE', err, {
      guildId: interaction.guild.id,
      channelId: data.channel.id,
      value
    });

    await interaction.followUp({
      content:
        '❌ Không thể đổi khu vực thoại. Discord có thể đã thay đổi danh sách khu vực.',
      ephemeral: true
    }).catch(() => {});
  }
}

async function handleOwnerButton(interaction) {
  const data = await requireOwner(interaction);
  if (!data) return;

  const action = interaction.customId;

  if (!checkCooldown(interaction.user.id, action)) {
    return shortReply(
      interaction,
      '⏳ Thao tác quá nhanh, vui lòng thử lại.'
    );
  }

  if (action === 'vc_lock') {
    await interaction.deferUpdate();
    await setRoomLocked(data.channel, true);
    await refreshPanelSafe(data.channel);

    return interaction.followUp({
      content: '🔒 Đã khóa phòng.',
      ephemeral: true
    }).catch(() => {});
  }

  if (action === 'vc_unlock') {
    await interaction.deferUpdate();
    await setRoomLocked(data.channel, false);
    await refreshPanelSafe(data.channel);

    return interaction.followUp({
      content: '🔓 Đã mở phòng.',
      ephemeral: true
    }).catch(() => {});
  }

  if (action === 'vc_hide') {
    await interaction.deferUpdate();
    await setRoomHidden(data.channel, true);
    await refreshPanelSafe(data.channel);

    return interaction.followUp({
      content: '🙈 Đã ẩn phòng.',
      ephemeral: true
    }).catch(() => {});
  }

  if (action === 'vc_show') {
    await interaction.deferUpdate();
    await setRoomHidden(data.channel, false);
    await refreshPanelSafe(data.channel);

    return interaction.followUp({
      content: '👁 Đã hiển thị phòng.',
      ephemeral: true
    }).catch(() => {});
  }

  if (action === 'vc_rename') {
    return interaction.showModal(
      renameModal(data.channel)
    );
  }

  if (action === 'vc_limit') {
    return interaction.showModal(
      limitModal(data.channel)
    );
  }

  if (action === 'vc_reset') {
    return safeReply(interaction, {
      content:
        '♻️ **Đặt lại phòng?**\n' +
        'Phòng sẽ được mở, hiện lại, bỏ giới hạn, trả khu vực về Tự động và xóa các quyền thành viên tùy chỉnh.',
      components: resetConfirmComponents(),
      ephemeral: true
    });
  }

  if (action === 'vc_allow') {
    const target = await resolveSelectedTarget(
      interaction,
      data
    );

    if (!target) return;

    await interaction.deferReply({ ephemeral: true });

    await allowMember(data.channel, target);
    await refreshPanelSafe(data.channel);

    return interaction.editReply({
      content:
        `✅ Đã cấp quyền vào phòng cho **${cleanDisplayName(target)}**.`
    });
  }

  if (action === 'vc_deny') {
    const target = await resolveSelectedTarget(
      interaction,
      data
    );

    if (!target) return;

    await interaction.deferReply({ ephemeral: true });

    await denyMember(data.channel, target);
    clearSelectedMember(data.channel.id);
    await refreshPanelSafe(data.channel);

    return interaction.editReply({
      content:
        `⛔ Đã cấm **${cleanDisplayName(target)}** khỏi phòng.`
    });
  }

  if (action === 'vc_kick') {
    const target = await resolveSelectedTarget(
      interaction,
      data,
      { mustBeInRoom: true }
    );

    if (!target) return;

    await interaction.deferReply({ ephemeral: true });

    await kickMember(data.channel, target);
    clearSelectedMember(data.channel.id);
    await refreshPanelSafe(data.channel);

    return interaction.editReply({
      content:
        `👢 Đã đuổi **${cleanDisplayName(target)}** khỏi phòng.`
    });
  }

  if (action === 'vc_transfer') {
    const target = await resolveSelectedTarget(
      interaction,
      data,
      { mustBeInRoom: true }
    );

    if (!target) return;

    await interaction.deferReply({ ephemeral: true });

    await createTransferRequest(
      interaction,
      data,
      target
    );

    return interaction.editReply({
      content:
        `👑 Đã gửi yêu cầu chuyển chủ cho **${cleanDisplayName(target)}**.`
    });
  }
}
// ============================================================
// 16) RESET CONFIRM
// ============================================================
async function handleResetConfirm(interaction) {
  if (interaction.customId === 'vc_reset_cancel') {
    return interaction.update({
      content: '❎ Đã hủy đặt lại phòng.',
      components: []
    });
  }

  const data = await requireOwner(interaction);
  if (!data) return;

  if (!checkCooldown(interaction.user.id, 'reset_confirm')) {
    return shortReply(
      interaction,
      '⏳ Thao tác quá nhanh, vui lòng thử lại.'
    );
  }

  await interaction.deferUpdate();

  try {
    await resetRoom(
      data.channel,
      data.room.owner_id
    );

    await refreshPanelSafe(
      data.channel,
      true
    );

    await interaction.editReply({
      content: '♻️ Đã đặt lại phòng thành công.',
      components: []
    });
  } catch (err) {
    logError('RESET_ROOM', err, {
      guildId: interaction.guild.id,
      channelId: data.channel.id,
      ownerId: data.room.owner_id
    });

    await interaction.editReply({
      content: '❌ Không thể đặt lại phòng.',
      components: []
    }).catch(() => {});
  }
}

// ============================================================
// 17) MODAL SUBMIT
// ============================================================
async function handleModalSubmit(interaction) {
  if (interaction.customId === 'vc_modal_rename') {
    const data = await requireOwner(interaction);
    if (!data) return;

    if (!checkCooldown(interaction.user.id, 'rename_modal')) {
      return shortReply(
        interaction,
        '⏳ Bạn đổi tên quá nhanh.'
      );
    }

    let name = interaction.fields
      .getTextInputValue('room_name')
      .replace(/\r?\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    name = name
      .replace(/^🔊・/, '')
      .replace(/[\/\\#:@]/g, '')
      .trim();

    if (!name) {
      return shortReply(
        interaction,
        '❌ Tên phòng không hợp lệ.'
      );
    }

    const finalName = `${ROOM_PREFIX}${name}`
      .slice(0, 100);

    await interaction.deferReply({
      ephemeral: true
    });

    try {
      await data.channel.setName(
        finalName,
        `Chủ phòng ${interaction.user.tag} đổi tên`
      );

      await refreshPanelSafe(data.channel);

      await interaction.editReply({
        content: `✏️ Đã đổi tên phòng thành **${finalName}**.`
      });
    } catch (err) {
      logError('ROOM_RENAME', err, {
        guildId: interaction.guild.id,
        channelId: data.channel.id
      });

      await interaction.editReply({
        content:
          '❌ Không thể đổi tên phòng. Có thể Discord đang giới hạn tốc độ đổi tên kênh.'
      });
    }

    return;
  }

  if (interaction.customId === 'vc_modal_limit') {
    const data = await requireOwner(interaction);
    if (!data) return;

    if (!checkCooldown(interaction.user.id, 'limit_modal')) {
      return shortReply(
        interaction,
        '⏳ Bạn thay đổi giới hạn quá nhanh.'
      );
    }

    const raw = interaction.fields
      .getTextInputValue('room_limit')
      .trim();

    if (!/^\d{1,2}$/.test(raw)) {
      return shortReply(
        interaction,
        '❌ Giới hạn phải là số từ **0 đến 99**.'
      );
    }

    const limit = Number(raw);

    if (
      !Number.isInteger(limit) ||
      limit < 0 ||
      limit > 99
    ) {
      return shortReply(
        interaction,
        '❌ Giới hạn phải nằm trong khoảng **0–99**.'
      );
    }

    await interaction.deferReply({
      ephemeral: true
    });

    try {
      await data.channel.setUserLimit(limit);

      await refreshPanelSafe(data.channel);

      await interaction.editReply({
        content:
          limit === 0
            ? '👥 Đã bỏ giới hạn số người.'
            : `👥 Giới hạn phòng đã đặt thành **${limit} người**.`
      });
    } catch (err) {
      logError('ROOM_LIMIT', err, {
        guildId: interaction.guild.id,
        channelId: data.channel.id,
        limit
      });

      await interaction.editReply({
        content: '❌ Không thể thay đổi giới hạn phòng.'
      });
    }

    return;
  }
}

// ============================================================
// 18) TRANSFER ACCEPT / DECLINE
// ============================================================
async function handleTransferResponse(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[0];
  const channelId = parts[1];

  if (!channelId || !isSnowflake(channelId)) {
    return shortReply(
      interaction,
      '❌ Yêu cầu chuyển chủ không hợp lệ.'
    );
  }

  const pending = pendingTransfers.get(
    String(channelId)
  );

  if (!pending) {
    return interaction.update({
      content:
        '⌛ Yêu cầu chuyển chủ này không còn hiệu lực.',
      components: []
    }).catch(() =>
      shortReply(
        interaction,
        '⌛ Yêu cầu chuyển chủ này không còn hiệu lực.'
      )
    );
  }

  if (Date.now() > pending.expiresAt) {
    pendingTransfers.delete(String(channelId));

    return interaction.update({
      content: '⌛ Yêu cầu chuyển chủ đã hết hạn.',
      components: []
    }).catch(() => {});
  }

  if (
    String(interaction.user.id) !==
    String(pending.toUserId)
  ) {
    return shortReply(
      interaction,
      '⛔ Chỉ thành viên được chọn mới có thể phản hồi yêu cầu này.'
    );
  }

  const channel = await interaction.guild.channels
    .fetch(channelId)
    .catch(() => null);

  if (
    !channel ||
    channel.type !== ChannelType.GuildVoice
  ) {
    pendingTransfers.delete(String(channelId));

    return interaction.update({
      content: '❌ Phòng thoại không còn tồn tại.',
      components: []
    }).catch(() => {});
  }

  if (action === 'vc_transfer_decline') {
    pendingTransfers.delete(String(channelId));

    await interaction.update({
      content:
        `❎ <@${interaction.user.id}> đã từ chối nhận phòng.`,
      components: [],
      allowedMentions: {
        users: [interaction.user.id]
      }
    });

    console.log(
      `[CHUYỂN CHỦ] ${interaction.user.id} đã từ chối | ${channel.name}`
    );

    return;
  }

  if (action !== 'vc_transfer_accept') return;

  const room = await getRoom(channel.id);

  if (
    !room ||
    String(room.owner_id) !==
      String(pending.fromOwnerId)
  ) {
    pendingTransfers.delete(String(channelId));

    return interaction.update({
      content:
        '❌ Chủ phòng đã thay đổi nên yêu cầu này bị hủy.',
      components: []
    }).catch(() => {});
  }

  const target = await interaction.guild.members
    .fetch(interaction.user.id)
    .catch(() => null);

  if (
    !target ||
    target.voice.channelId !== channel.id
  ) {
    return shortReply(
      interaction,
      '❌ Bạn phải đang ở trong phòng để nhận quyền chủ phòng.'
    );
  }

  await interaction.deferUpdate();

  try {
    await transferOwner(
      channel,
      pending.fromOwnerId,
      pending.toUserId
    );

    await refreshPanelSafe(
      channel,
      true
    );

    await interaction.editReply({
      content:
        `👑 <@${pending.toUserId}> đã nhận quyền chủ phòng từ <@${pending.fromOwnerId}>.`,
      components: [],
      allowedMentions: {
        users: [
          pending.toUserId,
          pending.fromOwnerId
        ]
      }
    });

    const blog = await getBlogChannel(
      interaction.guild
    );

    if (blog) {
      await blog.send({
        content:
          `[CHUYỂN CHỦ] <@${pending.fromOwnerId}> → <@${pending.toUserId}> • ${channel.name} • ${vietnamTime()}`,
        allowedMentions: {
          parse: []
        }
      }).catch(() => {});
    }
  } catch (err) {
    logError('TRANSFER_ACCEPT', err, {
      guildId: interaction.guild.id,
      channelId,
      fromOwnerId: pending.fromOwnerId,
      toUserId: pending.toUserId
    });

    pendingTransfers.delete(String(channelId));

    await interaction.editReply({
      content:
        '❌ Không thể hoàn tất chuyển chủ. Quyền sở hữu chưa được xác nhận.',
      components: []
    }).catch(() => {});
  }
}

// ============================================================
// 19) SLASH COMMAND HANDLERS
// ============================================================
async function handleTrackChannel(interaction) {
  if (
    !interaction.memberPermissions?.has(
      PermissionsBitField.Flags.Administrator
    )
  ) {
    return shortReply(
      interaction,
      '⛔ Chỉ quản trị viên mới sử dụng được lệnh này.'
    );
  }

  const config = await getGenerator(
    interaction.guild.id
  );

  if (!config) {
    return shortReply(
      interaction,
      '❌ Máy chủ chưa được thiết lập. Hãy chạy `/setup` trước.'
    );
  }

  const channel =
    interaction.options.getChannel('channel');

  if (
    !channel ||
    (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement
    )
  ) {
    return shortReply(
      interaction,
      '❌ Hãy chọn một kênh text hợp lệ.'
    );
  }

  const me = interaction.guild.members.me;
  const permissions = channel.permissionsFor(me);

  const required = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.ReadMessageHistory
  ];

  const missing = required.filter(
    flag => !permissions?.has(flag)
  );

  if (missing.length) {
    return safeReply(interaction, {
      content:
        '❌ Bot chưa đủ quyền đọc kênh được chọn.\n' +
        `Thiếu: **${permissionNames(missing).join(', ')}**`,
      ephemeral: true
    });
  }

  await updateTrackedChannel(
    interaction.guild.id,
    channel.id
  );

  await shortReply(
    interaction,
    `✅ Đã bật ghi nhận chat tại <#${channel.id}>.`
  );

  console.log(
    `[THEO DÕI CHAT] ${interaction.guild.name} → ${channel.name}`
  );
}

async function handleUntrackChannel(interaction) {
  if (
    !interaction.memberPermissions?.has(
      PermissionsBitField.Flags.Administrator
    )
  ) {
    return shortReply(
      interaction,
      '⛔ Chỉ quản trị viên mới sử dụng được lệnh này.'
    );
  }

  const config = await getGenerator(
    interaction.guild.id
  );

  if (!config) {
    return shortReply(
      interaction,
      '❌ Máy chủ chưa được thiết lập.'
    );
  }

  await clearTrackedChannel(
    interaction.guild.id
  );

  await shortReply(
    interaction,
    '✅ Đã tắt ghi nhận kênh chat.'
  );

  console.log(
    `[THEO DÕI CHAT] Đã tắt tại ${interaction.guild.name}`
  );
}

async function handlePanelCommand(interaction) {
  const member = await interaction.guild.members
    .fetch(interaction.user.id)
    .catch(() => null);

  if (!member?.voice?.channelId) {
    return shortReply(
      interaction,
      '❌ Bạn phải đang ở trong Temp Voice cần khôi phục panel.'
    );
  }

  const room = await getRoom(
    member.voice.channelId
  );

  if (!room) {
    return shortReply(
      interaction,
      '❌ Phòng hiện tại không phải Temp Voice của Voice HDK.'
    );
  }

  if (
    String(room.owner_id) !==
      String(interaction.user.id) &&
    !interaction.memberPermissions?.has(
      PermissionsBitField.Flags.Administrator
    )
  ) {
    return shortReply(
      interaction,
      '⛔ Chỉ chủ phòng hoặc quản trị viên mới có thể khôi phục panel.'
    );
  }

  const channel = member.voice.channel;

  await interaction.deferReply({
    ephemeral: true
  });

  const panel = await refreshPanelSafe(
    channel,
    true
  );

  if (!panel) {
    return interaction.editReply({
      content:
        '❌ Không thể khôi phục bảng điều khiển. Hãy kiểm tra quyền của bot.'
    });
  }

  await interaction.editReply({
    content:
      '✅ Bảng điều khiển đã được kiểm tra và khôi phục.'
  });
}

async function handleDoctor(interaction) {
  if (
    !interaction.memberPermissions?.has(
      PermissionsBitField.Flags.Administrator
    )
  ) {
    return shortReply(
      interaction,
      '⛔ Chỉ quản trị viên mới sử dụng được `/doctor`.'
    );
  }

  await interaction.deferReply({
    ephemeral: true
  });

  const checks = [];

  // Discord Gateway
  checks.push(
    client.isReady()
      ? '✅ Discord Gateway'
      : '❌ Discord Gateway'
  );

  // Database thật
  try {
    await pool.query('SELECT 1');
    checks.push('✅ PostgreSQL');
  } catch (err) {
    checks.push('❌ PostgreSQL');
    logError('DOCTOR_DB', err, {
      guildId: interaction.guild.id
    });
  }

  // Setup
  let config = null;

  try {
    config = await getGenerator(
      interaction.guild.id
    );

    checks.push(
      config
        ? '✅ Cấu hình máy chủ'
        : '❌ Chưa chạy /setup'
    );
  } catch (err) {
    checks.push('❌ Đọc cấu hình');
  }

  // Bot permissions
  const missing = missingBotPermissions(
    interaction.guild
  );

  checks.push(
    missing.length
      ? `❌ Thiếu quyền: ${permissionNames(missing).join(', ')}`
      : '✅ Quyền bot'
  );

  // Generator
  if (config?.generator_id) {
    const generator =
      await interaction.guild.channels
        .fetch(config.generator_id)
        .catch(() => null);

    checks.push(
      generator?.type === ChannelType.GuildVoice
        ? '✅ Phòng tạo Temp Voice'
        : '❌ Phòng tạo Temp Voice'
    );
  }

  // Blog
  if (config?.blog_channel_id) {
    const blog =
      await interaction.guild.channels
        .fetch(config.blog_channel_id)
        .catch(() => null);

    checks.push(
      blog?.type === ChannelType.GuildText
        ? '✅ Kênh blog'
        : '❌ Kênh blog'
    );
  }

  // Voice regions thật
  try {
    const regions = await getVoiceRegions(true);

    checks.push(
      regions.length
        ? `✅ Voice Regions (${regions.length})`
        : '⚠️ Voice Regions không có dữ liệu'
    );
  } catch (err) {
    checks.push('❌ Voice Regions');

    logError('DOCTOR_REGIONS', err, {
      guildId: interaction.guild.id
    });
  }

  const embed = new EmbedBuilder()
    .setColor(
      checks.some(x => x.startsWith('❌'))
        ? 0xED4245
        : 0x57F287
    )
    .setTitle(`${BOT_NAME} · Kiểm tra hệ thống`)
    .setDescription(checks.join('\n'));

  await interaction.editReply({
    embeds: [embed]
  });
}
// ============================================================
// 20) MAIN INTERACTION ROUTER
// ============================================================
client.on(Events.InteractionCreate, async interaction => {
  try {
    if (!interaction.guild) {
      if (interaction.isRepliable()) {
        await safeReply(interaction, {
          content:
            '❌ Voice HDK chỉ hoạt động trong máy chủ Discord.',
          ephemeral: true
        });
      }
      return;
    }

    // --------------------------------------------------------
    // SLASH COMMANDS
    // --------------------------------------------------------
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'setup') {
        await setupGuild(interaction);
        return;
      }

      if (interaction.commandName === 'panel') {
        await handlePanelCommand(interaction);
        return;
      }

      if (interaction.commandName === 'doctor') {
        await handleDoctor(interaction);
        return;
      }

      if (interaction.commandName === 'track-channel') {
        await handleTrackChannel(interaction);
        return;
      }

      if (interaction.commandName === 'untrack-channel') {
        await handleUntrackChannel(interaction);
        return;
      }

      return;
    }

    // --------------------------------------------------------
    // USER SELECT
    // --------------------------------------------------------
    if (
      interaction.isUserSelectMenu() &&
      interaction.customId === 'vc_member_select'
    ) {
      await handleMemberSelect(interaction);
      return;
    }

    // --------------------------------------------------------
    // REGION SELECT
    // --------------------------------------------------------
    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === 'vc_region_select'
    ) {
      await handleRegionSelect(interaction);
      return;
    }

    // --------------------------------------------------------
    // MODALS
    // --------------------------------------------------------
    if (interaction.isModalSubmit()) {
      if (
        interaction.customId === 'vc_modal_rename' ||
        interaction.customId === 'vc_modal_limit'
      ) {
        await handleModalSubmit(interaction);
      }

      return;
    }

    // --------------------------------------------------------
    // BUTTONS
    // --------------------------------------------------------
    if (interaction.isButton()) {
      if (
        interaction.customId === 'vc_reset_confirm' ||
        interaction.customId === 'vc_reset_cancel'
      ) {
        await handleResetConfirm(interaction);
        return;
      }

      if (
        interaction.customId.startsWith(
          'vc_transfer_accept:'
        ) ||
        interaction.customId.startsWith(
          'vc_transfer_decline:'
        )
      ) {
        await handleTransferResponse(interaction);
        return;
      }

      const ownerButtons = new Set([
        'vc_lock',
        'vc_unlock',
        'vc_hide',
        'vc_show',
        'vc_rename',
        'vc_reset',
        'vc_limit',
        'vc_allow',
        'vc_transfer',
        'vc_deny',
        'vc_kick'
      ]);

      if (ownerButtons.has(interaction.customId)) {
        await handleOwnerButton(interaction);
        return;
      }
    }
  } catch (err) {
    logError('INTERACTION', err, {
      guildId: interaction?.guild?.id,
      channelId: interaction?.channelId,
      userId: interaction?.user?.id,
      commandName: interaction?.commandName,
      customId: interaction?.customId
    });

    if (interaction?.isRepliable?.()) {
      try {
        if (interaction.deferred) {
          await interaction.editReply({
            content:
              '❌ Đã xảy ra lỗi khi xử lý thao tác. Hãy thử lại.'
          });
        } else if (interaction.replied) {
          await interaction.followUp({
            content:
              '❌ Đã xảy ra lỗi khi xử lý thao tác. Hãy thử lại.',
            ephemeral: true
          });
        } else {
          await interaction.reply({
            content:
              '❌ Đã xảy ra lỗi khi xử lý thao tác. Hãy thử lại.',
            ephemeral: true
          });
        }
      } catch (replyErr) {
        logError('INTERACTION_ERROR_REPLY', replyErr, {
          interactionId: interaction?.id
        });
      }
    }
  }
});

// ============================================================
// 21) RECONCILE DATABASE ↔ DISCORD
// ============================================================
async function reconcileGuild(guild) {
  const config = await getGenerator(guild.id);

  if (!config) return;

  const { rows } = await pool.query(
    `SELECT *
     FROM rooms
     WHERE guild_id=$1`,
    [guild.id]
  );

  for (const room of rows) {
    try {
      const channel = await guild.channels
        .fetch(room.channel_id)
        .catch(() => null);

      if (
        !channel ||
        channel.type !== ChannelType.GuildVoice
      ) {
        await deleteRoomRecord(room.channel_id);

        console.log(
          `[ĐỒNG BỘ] Đã xóa dữ liệu phòng không còn tồn tại: ${room.channel_id}`
        );

        continue;
      }

      await ensureBotRoomPermissions(channel);

      const owner = await guild.members
        .fetch(room.owner_id)
        .catch(() => null);

      if (owner) {
        await setOwnerAccess(
          channel,
          room.owner_id,
          true
        );
      }

      const humans = channel.members.filter(
        member => !member.user.bot
      );

      if (humans.size === 0) {
        await deleteTempRoom(channel);
        continue;
      }

      await refreshPanelSafe(
        channel,
        true
      );
    } catch (err) {
      logError('RECONCILE_ROOM', err, {
        guildId: guild.id,
        channelId: room.channel_id
      });
    }
  }
}

async function reconcileAllGuilds() {
  for (const guild of client.guilds.cache.values()) {
    try {
      await reconcileGuild(guild);
    } catch (err) {
      logError('RECONCILE_GUILD', err, {
        guildId: guild.id,
        guildName: guild.name
      });
    }
  }
}

// ============================================================
// 22) READY / STARTUP
// ============================================================
client.once(Events.ClientReady, async readyClient => {
  try {
    console.log(
      `[DISCORD] ${BOT_NAME} đã đăng nhập: ${readyClient.user.tag}`
    );

    await initDb();

    readyClient.user.setActivity(
      `${BOT_NAME} · /panel`
    );

    await registerCommands();

    // Tên hiển thị trong từng server.
    // Đây là nickname server, không thay đổi username của Discord Application.
    for (const guild of readyClient.guilds.cache.values()) {
      try {
        const me =
          guild.members.me ||
          await guild.members.fetchMe();

        if (
          me &&
          me.displayName !== BOT_NAME &&
          me.permissions.has(
            PermissionsBitField.Flags.ChangeNickname
          )
        ) {
          await me.setNickname(
            BOT_NAME,
            'Đồng bộ tên hiển thị Voice HDK'
          );
        }
      } catch (err) {
        console.warn(
          `[TÊN BOT] Không thể đổi nickname tại ${guild.name}:`,
          err?.message || err
        );
      }
    }

    await reconcileAllGuilds();

    console.log(
      `[HỆ THỐNG] ${BOT_NAME} đã sẵn sàng.`
    );
  } catch (err) {
    logError('STARTUP', err);

    // Nếu DB hoặc startup quan trọng thất bại,
    // không để Render hiển thị tiến trình "sống giả".
    setTimeout(() => {
      process.exit(1);
    }, 1000).unref?.();
  }
});

// ============================================================
// 23) GUILD CREATE
// ============================================================
client.on(Events.GuildCreate, async guild => {
  try {
    console.log(
      `[MÁY CHỦ] ${BOT_NAME} đã tham gia ${guild.name} (${guild.id})`
    );
  } catch (err) {
    logError('GUILD_CREATE', err, {
      guildId: guild?.id
    });
  }
});

// ============================================================
// 24) CLEANUP MAPS
// ============================================================
setInterval(() => {
  const now = Date.now();

  for (const [key, until] of cooldowns.entries()) {
    if (until <= now) {
      cooldowns.delete(key);
    }
  }

  for (
    const [channelId, transfer]
    of pendingTransfers.entries()
  ) {
    if (
      !transfer ||
      transfer.expiresAt <= now
    ) {
      pendingTransfers.delete(channelId);
    }
  }
}, 60_000).unref?.();

// ============================================================
// 25) GRACEFUL SHUTDOWN
// ============================================================
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log(
    `[HỆ THỐNG] Nhận ${signal}, đang đóng ${BOT_NAME}...`
  );

  try {
    client.destroy();
  } catch (err) {
    logError('SHUTDOWN_DISCORD', err);
  }

  try {
    await pool.end();
  } catch (err) {
    logError('SHUTDOWN_DATABASE', err);
  }

  process.exit(0);
}

process.once('SIGTERM', () => {
  shutdown('SIGTERM').catch(err => {
    logError('SHUTDOWN', err);
    process.exit(1);
  });
});

process.once('SIGINT', () => {
  shutdown('SIGINT').catch(err => {
    logError('SHUTDOWN', err);
    process.exit(1);
  });
});

// ============================================================
// 26) LOGIN
// ============================================================
console.log(
  `[HỆ THỐNG] Đang khởi động ${BOT_NAME}...`
);

client.login(TOKEN).catch(err => {
  logError('LOGIN', err);

  setTimeout(() => {
    process.exit(1);
  }, 500).unref?.();
});

// ============================================================
// UPTIMEROBOT / RENDER FREE
// ============================================================
// URL: https://TEN-SERVICE-CUA-BAN.onrender.com/health
// Method: GET
