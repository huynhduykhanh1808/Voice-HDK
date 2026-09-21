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
