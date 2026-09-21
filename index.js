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

// Render health endpoint
http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8'
  });

  res.end(JSON.stringify({
    ok: true,
    ready: client.isReady(),
    uptime: Math.floor(process.uptime())
  }));
}).listen(PORT, () => {
  console.log(`[WEB] Health server :${PORT}`);
});

// ============================================================
// 2) LOGGING / ERROR BOUNDARIES
// ============================================================
function logError(scope, err, context = {}) {
  const code = err?.code ?? err?.rawError?.code ?? 'UNKNOWN';

  console.error(
    `[${scope}] code=${code}`,
    context,
    err?.stack || err
  );
}

client.on(Events.Error, err => {
  logError('DISCORD_CLIENT', err);
});

client.on(Events.Warn, info => {
  console.warn('[DISCORD_WARN]', info);
});

process.on('unhandledRejection', err => {
  logError('UNHANDLED_REJECTION', err);
});

process.on('uncaughtException', err => {
  logError('UNCAUGHT_EXCEPTION', err);
});

pool.on('error', err => {
  logError('POSTGRES_POOL', err);
});

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

  await pool.query(`
    ALTER TABLE rooms
    ADD COLUMN IF NOT EXISTS control_message_id BIGINT
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS rooms_guild_owner_idx
    ON rooms(guild_id, owner_id)
  `);

  console.log('[DB] PostgreSQL ready');
}

async function getGenerator(guildId) {
  const { rows } = await pool.query(
    'SELECT * FROM generators WHERE guild_id=$1',
    [guildId]
  );

  return rows[0] || null;
}

async function saveGenerator(
  guildId,
  categoryId,
  generatorId,
  blogChannelId
) {
  await pool.query(`
    INSERT INTO generators(
      guild_id,
      category_id,
      generator_id,
      blog_channel_id
    )
    VALUES($1,$2,$3,$4)

    ON CONFLICT(guild_id)
    DO UPDATE SET
      category_id=EXCLUDED.category_id,
      generator_id=EXCLUDED.generator_id,
      blog_channel_id=EXCLUDED.blog_channel_id
  `, [
    guildId,
    categoryId,
    generatorId,
    blogChannelId
  ]);
}

async function updateTrackedChannel(guildId, channelId) {
  await pool.query(
    `UPDATE generators
     SET tracked_text_channel_id=$1
     WHERE guild_id=$2`,
    [channelId, guildId]
  );
}

async function clearTrackedChannel(guildId) {
  await pool.query(
    `UPDATE generators
     SET tracked_text_channel_id=NULL
     WHERE guild_id=$1`,
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
  const { rows } = await pool.query(`
    SELECT *
    FROM rooms
    WHERE guild_id=$1
      AND owner_id=$2
    ORDER BY channel_id DESC
    LIMIT 1
  `, [
    guildId,
    ownerId
  ]);

  return rows[0] || null;
}

async function saveRoom(
  guildId,
  channelId,
  ownerId,
  categoryId,
  controlMessageId = null
) {
  await pool.query(`
    INSERT INTO rooms(
      guild_id,
      channel_id,
      owner_id,
      category_id,
      control_message_id
    )
    VALUES($1,$2,$3,$4,$5)

    ON CONFLICT(channel_id)
    DO UPDATE SET
      owner_id=EXCLUDED.owner_id,
      category_id=EXCLUDED.category_id,
      control_message_id=COALESCE(
        EXCLUDED.control_message_id,
        rooms.control_message_id
      )
  `, [
    guildId,
    channelId,
    ownerId,
    categoryId || 0,
    controlMessageId
  ]);
}

async function setControlMessage(channelId, messageId) {
  await pool.query(
    `UPDATE rooms
     SET control_message_id=$1
     WHERE channel_id=$2`,
    [messageId, channelId]
  );
}

async function deleteRoomRecord(channelId) {
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
  const everyone =
    channel.permissionOverwrites.cache.get(
      channel.guild.roles.everyone.id
    );

  return {
    locked: Boolean(
      everyone?.deny.has(
        PermissionsBitField.Flags.Connect
      )
    ),

    hidden: Boolean(
      everyone?.deny.has(
        PermissionsBitField.Flags.ViewChannel
      )
    )
  };
}

function checkCooldown(userId, action) {
  const key = `${userId}:${action}`;
  const now = Date.now();
  const until = cooldowns.get(key) || 0;

  if (until > now) return false;

  cooldowns.set(
    key,
    now + COOLDOWN_MS
  );

  return true;
}

function permissionNames(bits) {
  const labels = new Map([
    [
      PermissionsBitField.Flags.ViewChannel,
      'Xem kênh'
    ],
    [
      PermissionsBitField.Flags.SendMessages,
      'Gửi tin nhắn'
    ],
    [
      PermissionsBitField.Flags.EmbedLinks,
      'Nhúng liên kết'
    ],
    [
      PermissionsBitField.Flags.ReadMessageHistory,
      'Đọc lịch sử'
    ],
    [
      PermissionsBitField.Flags.ManageChannels,
      'Quản lý kênh'
    ],
    [
      PermissionsBitField.Flags.ManageRoles,
      'Quản lý quyền'
    ],
    [
      PermissionsBitField.Flags.MoveMembers,
      'Di chuyển thành viên'
    ],
    [
      PermissionsBitField.Flags.Connect,
      'Kết nối voice'
    ]
  ]);

  return bits.map(
    x => labels.get(x) || String(x)
  );
}

function missingBotPermissions(guild, channel = null) {
  const me = guild.members.me;

  if (!me) {
    return REQUIRED_BOT_PERMS;
  }

  const perms = channel
    ? channel.permissionsFor(me)
    : me.permissions;

  return REQUIRED_BOT_PERMS.filter(
    p => !perms?.has(p)
  );
}

async function safeReply(
  interaction,
  content,
  {
    error = false,
    ttl = 2800
  } = {}
) {
  const payload = {
    content:
      `${error ? '❌' : '✅'} ${content}`,
    ephemeral: true
  };

  try {
    if (
      interaction.deferred ||
      interaction.replied
    ) {
      const msg =
        await interaction.followUp(payload);

      if (ttl && msg?.id) {
        setTimeout(() => {
          interaction.webhook
            .deleteMessage(msg.id)
            .catch(() => {});
        }, ttl);
      }
    } else {
      await interaction.reply(payload);

      if (ttl) {
        setTimeout(() => {
          interaction
            .deleteReply()
            .catch(() => {});
        }, ttl);
      }
    }
  } catch (e) {
    logError(
      'SAFE_REPLY',
      e,
      {
        customId: interaction.customId
      }
    );
  }
}

async function safeDeferUpdate(interaction) {
  if (
    !interaction.deferred &&
    !interaction.replied
  ) {
    await interaction.deferUpdate();
  }
}

async function sendBlogLog(
  guild,
  tag,
  content
) {
  try {
    const gen =
      await getGenerator(guild.id);

    if (!gen?.blog_channel_id) {
      return;
    }

    const ch =
      await guild.channels
        .fetch(
          String(gen.blog_channel_id)
        )
        .catch(() => null);

    if (!ch?.isTextBased()) {
      return;
    }

    const clean =
      String(content)
        .replace(/\s*\n\s*/g, ' ')
        .slice(0, 1500);

    await ch.send({
      content:
        `\`[${tag}]\` ` +
        `<t:${Math.floor(Date.now() / 1000)}:t>` +
        ` · ${clean}`,

      allowedMentions: {
        parse: []
      }
    });
  } catch (e) {
    logError(
      'BLOG_LOG',
      e,
      {
        guildId: guild.id,
        tag
      }
    );
  }
}

// ============================================================
// 5) PERMISSION ENGINE
//
// Chủ phòng KHÔNG nhận ManageChannels / ManageRoles.
// Bot là bên duy nhất quản lý cấu trúc phòng.
// ============================================================
async function ensureBotRoomPermissions(channel) {
  const me = channel.guild.members.me;

  if (!me) {
    throw new Error(
      'Không tìm thấy bot member.'
    );
  }

  const missing =
    missingBotPermissions(channel.guild);

  if (missing.length) {
    throw new Error(
      `BOT_MISSING_PERMS:` +
      `${permissionNames(missing).join(', ')}`
    );
  }

  await channel.permissionOverwrites.edit(
    me,
    {
      ViewChannel: true,
      SendMessages: true,
      EmbedLinks: true,
      ReadMessageHistory: true,

      Connect: true,
      Speak: true,

      ManageChannels: true,
      ManageRoles: true,
      MoveMembers: true
    },
    {
      reason:
        'TempVoice: bảo đảm quyền vận hành của bot'
    }
  );
}

async function setOwnerAccess(
  channel,
  memberOrId,
  enabled = true
) {
  const member =
    typeof memberOrId === 'string'
      ? await channel.guild.members
          .fetch(memberOrId)
          .catch(() => null)
      : memberOrId;

  if (!member) {
    return false;
  }

  if (enabled) {
    await channel.permissionOverwrites.edit(
      member,
      {
        ViewChannel: true,
        Connect: true,
        Speak: true,
        UseVAD: true
      },
      {
        reason:
          'TempVoice: quyền truy cập chủ phòng'
      }
    );
  } else {
    await channel.permissionOverwrites
      .delete(
        member,
        'TempVoice: thu hồi quyền chủ cũ'
      )
      .catch(() => {});
  }

  return true;
}

async function transferOwner(
  channel,
  newOwner
) {
  const room =
    await getRoom(channel.id);

  if (!room) {
    throw new Error('ROOM_NOT_FOUND');
  }

  if (
    String(room.owner_id) === newOwner.id
  ) {
    return;
  }

  const oldOwnerId =
    String(room.owner_id);

  await ensureBotRoomPermissions(channel);

  await setOwnerAccess(
    channel,
    newOwner,
    true
  );

  await saveRoom(
    channel.guild.id,
    channel.id,
    newOwner.id,
    channel.parentId || 0
  );

  if (oldOwnerId !== newOwner.id) {
    await setOwnerAccess(
      channel,
      oldOwnerId,
      false
    );
  }
}

async function setRoomLocked(
  channel,
  locked
) {
  await ensureBotRoomPermissions(channel);

  await channel.permissionOverwrites.edit(
    channel.guild.roles.everyone,
    {
      Connect:
        locked ? false : null
    },
    {
      reason:
        `TempVoice: ` +
        `${locked ? 'khóa' : 'mở'} phòng`
    }
  );
}

async function setRoomHidden(
  channel,
  hidden
) {
  await ensureBotRoomPermissions(channel);

  await channel.permissionOverwrites.edit(
    channel.guild.roles.everyone,
    {
      ViewChannel:
        hidden ? false : null
    },
    {
      reason:
        `TempVoice: ` +
        `${hidden ? 'ẩn' : 'hiện'} phòng`
    }
  );

  const room =
    await getRoom(channel.id);

  if (room) {
    await setOwnerAccess(
      channel,
      String(room.owner_id),
      true
    );
  }
}

// ============================================================
// 6) LIVE DISCORD VOICE REGIONS
//
// Không hard-code ID khu vực.
// Discord API là nguồn dữ liệu chính.
// ============================================================
async function getVoiceRegions(
  { force = false } = {}
) {
  if (
    !force &&
    regionCache.expires > Date.now() &&
    regionCache.items.length
  ) {
    return regionCache.items;
  }

  try {
        const regions =
      await client.fetchVoiceRegions();

    const items =
      [...regions.values()]
        .filter(
          r =>
            !r.deprecated &&
            !r.custom
        )
        .sort(
          (a, b) =>
            a.name.localeCompare(
              b.name,
              'vi'
            )
        );

    regionCache = {
      expires:
        Date.now() +
        6 * 60 * 60 * 1000,

      items
    };

    return items;
  } catch (e) {
    logError(
      'VOICE_REGIONS_FETCH',
      e
    );

    // Nếu Discord API tạm lỗi nhưng cache cũ
    // vẫn tồn tại thì tiếp tục dùng cache.
    if (regionCache.items.length) {
      return regionCache.items;
    }

    return [];
  }
}

async function setRoomRegion(
  channel,
  regionId
) {
  await ensureBotRoomPermissions(channel);

  let target = null;

  if (
    regionId &&
    regionId !== 'auto'
  ) {
    const regions =
      await getVoiceRegions();

    const found =
      regions.find(
        r =>
          r.id === regionId &&
          !r.deprecated &&
          !r.custom
      );

    if (!found) {
      throw new Error(
        'REGION_INVALID'
      );
    }

    target = found.id;
  }

  await channel.setRTCRegion(
    target,
    'TempVoice: đổi khu vực thoại'
  );

  // Lấy lại trạng thái thật từ Discord.
  const refreshed =
    await channel.fetch(true);

  return refreshed.rtcRegion;
}

// ============================================================
// 7) PANEL UI
// ============================================================
function shortRegionName(
  regionId,
  regions = []
) {
  if (!regionId) {
    return 'Tự động';
  }

  const found =
    regions.find(
      r => r.id === regionId
    );

  return (
    found?.name ||
    regionId
  );
}

async function buildPanel(
  channel
) {
  const room =
    await getRoom(channel.id);

  if (!room) {
    throw new Error(
      'ROOM_NOT_FOUND'
    );
  }

  const owner =
    await channel.guild.members
      .fetch(
        String(room.owner_id)
      )
      .catch(() => null);

  const regions =
    await getVoiceRegions();

  const state =
    roomState(channel);

  const regionName =
    shortRegionName(
      channel.rtcRegion,
      regions
    );

  const memberCount =
    channel.members
      .filter(
        member =>
          !member.user.bot
      )
      .size;

  const limit =
    channel.userLimit > 0
      ? channel.userLimit
      : '∞';

  const ownerText =
    owner
      ? `<@${owner.id}>`
      : 'Không xác định';

  const accessText =
    state.locked
      ? '🔒 Đã khóa'
      : '🔓 Đang mở';

  const visibilityText =
    state.hidden
      ? '🙈 Đang ẩn'
      : '👁️ Hiển thị';

  const embed =
    new EmbedBuilder()
      .setColor(APP_COLOR)
      .setAuthor({
        name:
          'VOICE CONTROL · TEMP ROOM',
        iconURL:
          client.user.displayAvatarURL()
      })
      .setTitle(
        `🔊 ${channel.name}`
      )
      .setDescription(
        [
          `👑 **Chủ phòng**  ${ownerText}`,
          '',
          `👥 **Thành viên**  ${memberCount} / ${limit}`,
          `🛡️ **Trạng thái**  ${accessText}  •  ${visibilityText}`,
          `🌐 **Khu vực**  ${regionName}`,
          '',
          'Điều khiển phòng nhanh, riêng tư và gọn gàng.'
        ].join('\n')
      )
      .setFooter({
        text:
          'Voice Control • Trạng thái được đồng bộ trực tiếp từ Discord'
      });

  if (owner) {
    embed.setThumbnail(
      owner.displayAvatarURL({
        size: 256
      })
    );
  }

  // Row 1:
  // Lock/Unlock | Hide/Show | Rename | Limit
  const row1 =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            state.locked
              ? 'vc_unlock'
              : 'vc_lock'
          )
          .setLabel(
            state.locked
              ? 'Mở phòng'
              : 'Khóa phòng'
          )
          .setEmoji(
            state.locked
              ? '🔓'
              : '🔒'
          )
          .setStyle(
            state.locked
              ? ButtonStyle.Success
              : ButtonStyle.Secondary
          ),

        new ButtonBuilder()
          .setCustomId(
            state.hidden
              ? 'vc_unhide'
              : 'vc_hide'
          )
          .setLabel(
            state.hidden
              ? 'Hiện phòng'
              : 'Ẩn phòng'
          )
          .setEmoji(
            state.hidden
              ? '👁️'
              : '🙈'
          )
          .setStyle(
            state.hidden
              ? ButtonStyle.Success
              : ButtonStyle.Secondary
          ),

        new ButtonBuilder()
          .setCustomId(
            'vc_rename'
          )
          .setLabel(
            'Đổi tên'
          )
          .setEmoji('✏️')
          .setStyle(
            ButtonStyle.Primary
          ),

        new ButtonBuilder()
          .setCustomId(
            'vc_limit'
          )
          .setLabel(
            'Giới hạn'
          )
          .setEmoji('👥')
          .setStyle(
            ButtonStyle.Primary
          )
      );

  // Row 2:
  // Allow | Deny | Kick | Transfer | Reset
  const row2 =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'vc_allow'
          )
          .setLabel(
            'Cho phép'
          )
          .setEmoji('✅')
          .setStyle(
            ButtonStyle.Success
          ),

        new ButtonBuilder()
          .setCustomId(
            'vc_deny'
          )
          .setLabel(
            'Cấm'
          )
          .setEmoji('⛔')
          .setStyle(
            ButtonStyle.Danger
          ),

        new ButtonBuilder()
          .setCustomId(
            'vc_kick'
          )
          .setLabel(
            'Đuổi'
          )
          .setEmoji('👢')
          .setStyle(
            ButtonStyle.Danger
          ),

        new ButtonBuilder()
          .setCustomId(
            'vc_transfer'
          )
          .setLabel(
            'Chuyển chủ'
          )
          .setEmoji('👑')
          .setStyle(
            ButtonStyle.Success
          ),

        new ButtonBuilder()
          .setCustomId(
            'vc_reset'
          )
          .setLabel(
            'Đặt lại'
          )
          .setEmoji('♻️')
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  // Region select chiếm toàn bộ hàng cuối.
  const regionMenu =
    new StringSelectMenuBuilder()
      .setCustomId(
        'vc_region_select'
      )
      .setPlaceholder(
        `🌐 Khu vực thoại · ${regionName}`
      )
      .setMinValues(1)
      .setMaxValues(1);

  regionMenu.addOptions({
    label:
      'Tự động · Discord đề xuất',
    description:
      'Để Discord tự chọn kết nối phù hợp',
    value: 'auto',
    emoji: '⚡',
    default:
      !channel.rtcRegion
  });

  // Discord Select Menu tối đa 25 options.
  // 1 option dành cho Automatic.
  for (
    const region of
      regions.slice(0, 24)
  ) {
    regionMenu.addOptions({
      label:
        region.name.slice(
          0,
          100
        ),

      description:
        'Khu vực thoại Discord',

      value:
        region.id,

      emoji: '🌐',

      default:
        channel.rtcRegion ===
        region.id
    });
  }

  // Nếu Discord region API đang tạm lỗi,
  // Automatic vẫn phải sử dụng được.
  if (!regions.length) {
    regionMenu.setPlaceholder(
      '🌐 Khu vực thoại · Automatic'
    );
  }

  const row3 =
    new ActionRowBuilder()
      .addComponents(
        regionMenu
      );

  return {
    embeds: [embed],
    components: [
      row1,
      row2,
      row3
    ]
  };
}

async function findControlMessage(
  channel,
  room
) {
  if (
    !room?.control_message_id ||
    !isSnowflake(
      room.control_message_id
    )
  ) {
    return null;
  }

  try {
    return await channel.messages.fetch(
      String(
        room.control_message_id
      )
    );
  } catch (_) {
    return null;
  }
}

async function refreshPanel(
  channel,
  knownMessage = null,
  {
    recreate = false
  } = {}
) {
  try {
    const room =
      await getRoom(channel.id);

    if (!room) {
      throw new Error(
        'ROOM_NOT_FOUND'
      );
    }

    await ensureBotRoomPermissions(
      channel
    );

    const payload =
      await buildPanel(channel);

    let message =
      knownMessage;

    if (
      message &&
      message.channelId !==
        channel.id
    ) {
      message = null;
    }

    if (
      !message &&
      !recreate
    ) {
      message =
        await findControlMessage(
          channel,
          room
        );
    }

    if (message) {
      try {
        await message.edit(
          payload
        );

        if (
          String(
            room.control_message_id ||
            ''
          ) !== message.id
        ) {
          await setControlMessage(
            channel.id,
            message.id
          );
        }

        return message;
      } catch (e) {
        logError(
          'PANEL_EDIT',
          e,
          {
            guildId:
              channel.guild.id,
            channelId:
              channel.id,
            messageId:
              message.id
          }
        );

        message = null;
      }
    }

    // Nếu /panel yêu cầu recreate,
    // panel cũ được xóa nếu còn tồn tại.
    if (
      recreate &&
      room.control_message_id
    ) {
      const old =
        await findControlMessage(
          channel,
          room
        );

      if (old) {
        await old.delete()
          .catch(() => {});
      }
    }

    const sent =
      await channel.send(
        payload
      );

    await setControlMessage(
      channel.id,
      sent.id
    );

    // Xác minh Discord thực sự trả lại message.
    await channel.messages.fetch(
      sent.id
    );

    return sent;
  } catch (e) {
    const perms =
      channel.guild.members.me
        ? channel
            .permissionsFor(
              channel.guild.members.me
            )
            ?.toArray()
        : [];

    logError(
      'PANEL_CREATE_FAILED',
      e,
      {
        guildId:
          channel.guild.id,

        channelId:
          channel.id,

        channelName:
          channel.name,

        permissions:
          perms
      }
    );

    throw e;
  }
}

async function createPanelWithRetry(
  channel
) {
  const delays = [
    350,
    1000,
    2200
  ];

  let lastError;

  for (
    const delay of delays
  ) {
    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          delay
        )
    );

    try {
      return await refreshPanel(
        channel
      );
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError;
}

// ============================================================
// 8) ROOM CREATION / CLEANUP
// ============================================================
async function createRoom(
  guild,
  member,
  generatorChannel
) {
  const existing =
    await getOwnedRoom(
      guild.id,
      member.id
    );

  if (existing) {
    const existingChannel =
      await guild.channels
        .fetch(
          String(
            existing.channel_id
          )
        )
        .catch(() => null);

    if (
      existingChannel?.type ===
      ChannelType.GuildVoice
    ) {
      try {
        await member.voice.setChannel(
          existingChannel,
          'TempVoice: quay lại phòng đang sở hữu'
        );
      } catch (e) {
        logError(
          'MOVE_EXISTING_ROOM',
          e,
          {
            guildId: guild.id,
            userId: member.id
          }
        );
      }

      await refreshPanel(
        existingChannel
      ).catch(() => {});

      return existingChannel;
    }

    await deleteRoomRecord(
      existing.channel_id
    );
  }

  const gen =
    await getGenerator(
      guild.id
    );

  const categoryId =
    gen?.category_id ||
    generatorChannel?.parentId;

  if (!categoryId) {
    throw new Error(
      'Không xác định được category Temp Voice.'
    );
  }

  const me =
    guild.members.me;

  const roomName =
    `${ROOM_PREFIX}${member.displayName}`
      .slice(0, 100);

  const newChannel =
    await guild.channels.create({
      name: roomName,
      type:
        ChannelType.GuildVoice,
      parent:
        String(categoryId),

      permissionOverwrites: [
        {
          id:
            guild.roles.everyone.id,

          allow: [
            PermissionsBitField
              .Flags.ViewChannel,

            PermissionsBitField
              .Flags.Connect
          ]
        },

        {
          id: member.id,

          allow: [
            PermissionsBitField
              .Flags.ViewChannel,

            PermissionsBitField
              .Flags.Connect,

            PermissionsBitField
              .Flags.Speak,

            PermissionsBitField
              .Flags.UseVAD
          ]
        },

        {
          id: me.id,

          allow: [
            PermissionsBitField
              .Flags.ViewChannel,

            PermissionsBitField
              .Flags.SendMessages,

            PermissionsBitField
              .Flags.EmbedLinks,

            PermissionsBitField
              .Flags.ReadMessageHistory,

            PermissionsBitField
              .Flags.Connect,

            PermissionsBitField
              .Flags.Speak,

            PermissionsBitField
              .Flags.ManageChannels,

            PermissionsBitField
              .Flags.ManageRoles,

            PermissionsBitField
              .Flags.MoveMembers
          ]
        }
      ],

      reason:
        `TempVoice: tạo cho ${member.user.tag}`
    });

  try {
    await saveRoom(
      guild.id,
      newChannel.id,
      member.id,
      categoryId
    );

    await member.voice.setChannel(
      newChannel,
      'TempVoice: chuyển chủ vào phòng mới'
    );

    // Panel không được phép phá việc tạo phòng.
    createPanelWithRetry(
      newChannel
    ).catch(e => {
      logError(
        'PANEL_RETRY_EXHAUSTED',
        e,
        {
          guildId: guild.id,
          channelId:
            newChannel.id,
          ownerId:
            member.id
        }
      );
    });

    await sendBlogLog(
      guild,
      'TẠO PHÒNG',
      `${member.user.tag} → ${newChannel.name}`
    );

    return newChannel;
  } catch (e) {
    // Nếu tạo channel xong nhưng save/move thất bại,
    // không để lại phòng zombie.
    await deleteRoomRecord(
      newChannel.id
    ).catch(() => {});

    await newChannel.delete(
      'TempVoice: rollback do tạo phòng thất bại'
    ).catch(() => {});

    throw e;
  }
}

async function reconcileGuild(
  guild
) {
  const { rows } =
    await pool.query(
      `SELECT *
       FROM rooms
       WHERE guild_id=$1`,
      [guild.id]
    );

  for (
    const room of rows
  ) {
    const channel =
      await guild.channels
        .fetch(
          String(
            room.channel_id
          )
        )
        .catch(() => null);

    if (
      !channel ||
      channel.type !==
        ChannelType.GuildVoice
    ) {
      await deleteRoomRecord(
        room.channel_id
      );

      continue;
    }

    if (
      channel.members.size === 0
    ) {
      await deleteRoomRecord(
        channel.id
      );

      await channel.delete(
        'TempVoice: dọn phòng trống sau restart'
      ).catch(() => {});

      continue;
    }

    await ensureBotRoomPermissions(
      channel
    ).catch(
      e =>
        logError(
          'RECONCILE_PERMISSIONS',
          e,
          {
            channelId:
              channel.id
          }
        )
    );

    await refreshPanel(
      channel
    ).catch(() => {});
  }
}

// ============================================================
// 9) DOCTOR
// ============================================================
async function doctorText(
  guild
) {
  const lines = [];

  try {
    await pool.query(
      'SELECT 1'
    );

    lines.push(
      '🟢 **Database** · Online'
    );
  } catch (_) {
    lines.push(
      '🔴 **Database** · Lỗi kết nối'
    );
  }

  lines.push(
    client.isReady()
      ? '🟢 **Discord Gateway** · Online'
      : '🔴 **Discord Gateway** · Offline'
  );

  const missing =
    missingBotPermissions(guild);

  if (!missing.length) {
    lines.push(
      '🟢 **Quyền bot** · Đầy đủ'
    );
  } else {
    lines.push(
      `🔴 **Quyền bot** · Thiếu: ` +
      `${permissionNames(missing).join(', ')}`
    );
  }

  const gen =
    await getGenerator(
      guild.id
    );

  if (
    gen?.generator_id &&
    gen?.category_id
  ) {
    const generator =
      await guild.channels
        .fetch(
          String(
            gen.generator_id
          )
        )
        .catch(() => null);

    const category =
      await guild.channels
        .fetch(
          String(
            gen.category_id
          )
        )
        .catch(() => null);

    if (
      generator &&
      category
    ) {
      lines.push(
        '🟢 **Temp Voice** · Ready'
      );
    } else {
      lines.push(
        '🟠 **Temp Voice** · Dữ liệu setup cũ, nên chạy `/setup` lại'
      );
    }
  } else {
    lines.push(
      '🟠 **Temp Voice** · Chưa `/setup`'
    );
  }

  try {
    const regions =
      await getVoiceRegions({
        force: true
      });

    if (regions.length) {
      lines.push(
        `🟢 **Voice Regions** · ` +
        `${regions.length} vùng + Automatic`
      );
    } else {
      lines.push(
        '🟠 **Voice Regions** · API không trả danh sách; Automatic vẫn khả dụng'
      );
    }
  } catch (_) {
    lines.push(
      '🟠 **Voice Regions** · API tạm thời không khả dụng'
    );
  }

  return [
    '## 🩺 Voice Control · System Check',
    '',
    ...lines,
    '',
    'Dùng `/panel` khi cần dựng lại bảng điều khiển của phòng hiện tại.'
  ].join('\n');
}

// ============================================================
// 10) READY / COMMANDS
// ============================================================
client.once(
  Events.ClientReady,
  async readyClient => {
    try {
      await initDb();

      readyClient.user.setActivity(
        'Voice Control V3.1 · /panel'
      );

      await readyClient.application
        .commands.set([
          {
            name: 'setup',
            description:
              '[Admin] Cài đặt hệ thống Temp Voice',

            defaultMemberPermissions:
              PermissionsBitField
                .Flags.Administrator
                .toString()
          },

          {
            name: 'doctor',
            description:
              '[Admin] Kiểm tra DB, quyền và trạng thái bot',

            defaultMemberPermissions:
              PermissionsBitField
                .Flags.Administrator
                .toString()
          },

          {
            name: 'panel',
            description:
              'Dựng lại bảng điều khiển cho phòng Temp Voice hiện tại'
          },

          {
            name:
              'track-channel',

            description:
              '[Admin] Theo dõi log chat của kênh hiện tại',

            defaultMemberPermissions:
              PermissionsBitField
                .Flags.Administrator
                .toString()
          },

          {
            name:
              'untrack-channel',

            description:
              '[Admin] Dừng theo dõi kênh chat',

            defaultMemberPermissions:
              PermissionsBitField
                .Flags.Administrator
                .toString()
          }
        ]);

      console.log(
        `[READY] ${readyClient.user.tag}`
      );

      for (
        const guild of
          readyClient.guilds.cache.values()
      ) {
        await reconcileGuild(
          guild
        ).catch(
          e =>
            logError(
              'RECONCILE',
              e,
              {
                guildId:
                  guild.id
              }
            )
        );
      }
    } catch (e) {
      logError(
        'STARTUP',
        e
      );

      // DB là thành phần bắt buộc.
      // Không để bot online giả khi DB chết.
      process.exitCode = 1;

      setTimeout(
        () => process.exit(1),
        1500
      );
    }
  }
);

// ============================================================
// 11) VOICE STATE
// ============================================================
client.on(
  Events.VoiceStateUpdate,
  async (
    oldState,
    newState
  ) => {
    try {
      const member =
        newState.member ||
        oldState.member;

      if (
        !member ||
        member.user.bot
      ) {
        return;
      }

      const gen =
        await getGenerator(
          member.guild.id
        );

      // User vừa vào generator.
      if (
        newState.channelId &&
        newState.channelId !==
          oldState.channelId &&
        gen?.generator_id &&
        newState.channelId ===
          String(
            gen.generator_id
          )
      ) {
        await createRoom(
          member.guild,
          member,
          newState.channel?.parent
        );
      }

      // User vừa rời một channel.
      if (
        oldState.channelId &&
        oldState.channelId !==
          newState.channelId
      ) {
        if (
          gen?.generator_id &&
          oldState.channelId ===
            String(
              gen.generator_id
            )
        ) {
          return;
        }

        const room =
          await getRoom(
            oldState.channelId
          );

        const channel =
          oldState.channel;

        if (
          !room ||
          !channel
        ) {
          return;
        }

        if (
          channel.members.size === 0
        ) {
          await deleteRoomRecord(
            channel.id
          );

          await channel.delete(
            'TempVoice: phòng trống'
          ).catch(
            e =>
              logError(
                'ROOM_DELETE',
                e,
                {
                  channelId:
                    channel.id
                }
              )
          );

          await sendBlogLog(
            member.guild,
            'XÓA PHÒNG',
            channel.name
          );
        } else {
          await refreshPanel(
            channel
          ).catch(() => {});
        }
      }

      // User vừa vào Temp Voice.
      if (
        newState.channelId &&
        newState.channelId !==
          oldState.channelId
      ) {
        const room =
          await getRoom(
            newState.channelId
          );

        if (
          room &&
          newState.channel
        ) {
          await refreshPanel(
            newState.channel
          ).catch(() => {});
        }
      }
    } catch (e) {
      logError(
        'VOICE_STATE',
        e,
        {
          old:
            oldState.channelId,

          next:
            newState.channelId
        }
      );
    }
  }
);

// ============================================================
// 12) MESSAGE LOG
// ============================================================
client.on(
  Events.MessageCreate,
  async message => {
    try {
      if (
        !message.guild ||
        message.author.bot
      ) {
        return;
      }

      const room =
        await getRoom(
          message.channel.id
        );

      if (room) {
        await sendBlogLog(
          message.guild,
          'CHAT PHÒNG',
          `${message.author.tag}: ` +
          `${
            (
              message.content ||
              '[tệp]'
            ).slice(
              0,
              500
            )
          }`
        );
      }

      const gen =
        await getGenerator(
          message.guild.id
        );

      if (
        gen?.tracked_text_channel_id &&
        message.channel.id ===
          String(
            gen.tracked_text_channel_id
          )
      ) {
        await sendBlogLog(
          message.guild,
          'THEO DÕI CHAT',
          `${message.author.tag}: ` +
          `${
            (
              message.content ||
              '[tệp]'
            ).slice(
              0,
              500
            )
          }`
        );
      }
    } catch (e) {
      logError(
        'MESSAGE_LOG',
        e
      );
    }
  }
);

// ============================================================
// 13) INTERACTION HELPERS
// ============================================================
async function requireRoomInteraction(
  interaction,
  ownerOnly = true
) {
  const channel =
    interaction.member
      ?.voice
      ?.channel;

  if (!channel) {
    throw new Error(
      'USER_NOT_IN_VOICE'
    );
  }

  const room =
    await getRoom(
      channel.id
    );

  if (!room) {
    throw new Error(
      'NOT_TEMP_ROOM'
    );
  }

  if (
    ownerOnly &&
    String(room.owner_id) !==
      interaction.user.id
  ) {
    throw new Error(
      'NOT_OWNER'
    );
  }

  return {
    channel,
    room
  };
}

function friendlyError(err) {
  const msg =
    String(
      err?.message ||
      err
    );

  if (
    msg ===
    'USER_NOT_IN_VOICE'
  ) {
    return (
      'Bạn cần ở trong ' +
      'phòng thoại của mình.'
    );
  }

  if (
    msg ===
    'NOT_TEMP_ROOM'
  ) {
    return (
      'Đây không phải phòng thoại ' +
      'tạm do bot quản lý.'
    );
  }

  if (
    msg ===
    'NOT_OWNER'
  ) {
    return (
      'Chỉ chủ phòng mới dùng được ' +
      'chức năng này.'
    );
  }

  if (
    msg ===
    'ROOM_NOT_FOUND'
  ) {
    return (
      'Không tìm thấy dữ liệu phòng. ' +
      'Hãy vào lại kênh tạo phòng.'
    );
  }

  if (
    msg ===
    'REGION_INVALID'
  ) {
    return (
      'Khu vực thoại này không còn ' +
      'được Discord hỗ trợ. ' +
      'Hãy chọn Automatic hoặc vùng khác.'
    );
  }

  if (
    msg.startsWith(
      'BOT_MISSING_PERMS:'
    )
  ) {
    return (
      'Bot đang thiếu quyền: **' +
      msg
        .split(':')
        .slice(1)
        .join(':') +
      '**. Admin hãy chạy `/doctor`.'
    );
  }

  if (
    err?.code === 50013
  ) {
    return (
      'Bot thiếu quyền Discord để ' +
      'thực hiện thao tác này. ' +
      'Admin hãy chạy `/doctor`.'
    );
  }

  if (
    err?.code === 10003 ||
    err?.code === 10008
  ) {
    return (
      'Phòng hoặc bảng điều khiển ' +
      'không còn tồn tại.'
    );
  }

  return (
    'Không thể hoàn tất thao tác. ' +
    'Bot đã ghi log kỹ thuật để kiểm tra.'
  );
}

// ============================================================
// 14) INTERACTIONS — bắt đầu
// ============================================================
client.on(
  Events.InteractionCreate,
  async interaction => {
    if (!interaction.guild) {
      return;
    }

    try {
      // --------------------------------------------
      // Slash commands
      // --------------------------------------------
      if (
        interaction.isChatInputCommand()
      ) {
        if (
          interaction.commandName ===
          'doctor'
        ) {
          return interaction.reply({
            content:
              await doctorText(
                interaction.guild
              ),

            ephemeral: true
          });
        }

        if (
          interaction.commandName ===
          'panel'
        ) {
          const {
            channel,
            room
          } =
            await requireRoomInteraction(
              interaction,
              false
            );

          const isOwner =
            String(
              room.owner_id
            ) ===
            interaction.user.id;

          const isAdmin =
            interaction
              .memberPermissions
              ?.has(
                PermissionsBitField
                  .Flags.Administrator
              );

          if (
            !isOwner &&
            !isAdmin
          ) {
            return safeReply(
              interaction,
              'Chỉ chủ phòng hoặc quản trị viên mới có thể dựng lại bảng điều khiển.',
              {
                error: true
              }
            );
          }

          await interaction.deferReply({
            ephemeral: true
          });

          const msg =
            await refreshPanel(
              channel,
              null,
              {
                recreate: true
              }
            );

          await interaction.editReply({
            content:
              `✅ Bảng điều khiển đã được dựng lại trong <#${channel.id}>.`
          });

          setTimeout(
            () => {
              interaction
                .deleteReply()
                .catch(() => {});
            },
            3500
          );

          return msg;
        }

        if (
          interaction.commandName ===
          'track-channel'
        ) {
          if (
            !interaction.channel
              ?.isTextBased()
          ) {
            return safeReply(
              interaction,
              'Lệnh này chỉ dùng trong kênh văn bản.',
              {
                error: true
              }
            );
          }

          await updateTrackedChannel(
            interaction.guild.id,
            interaction.channel.id
          );

          return safeReply(
            interaction,
            'Đã bật theo dõi kênh hiện tại.'
          );
        }

        if (
          interaction.commandName ===
          'untrack-channel'
        ) {
          await clearTrackedChannel(
            interaction.guild.id
          );

          return safeReply(
            interaction,
            'Đã tắt theo dõi kênh.'
          );
        }

        if (
          interaction.commandName ===
          'setup'
        ) {
          const missing =
            missingBotPermissions(
              interaction.guild
            );

          if (missing.length) {
            return interaction.reply({
              content:
                '❌ Bot chưa đủ quyền để vận hành ổn định:\n' +
                `**${permissionNames(missing).join(', ')}**\n\n` +
                'Hãy cấp các quyền này cho role bot rồi chạy `/setup` lại.',

              ephemeral: true
            });
          }

          const cats =
            interaction.guild
              .channels
              .cache
              .filter(
                c =>
                  c.type ===
                  ChannelType.GuildCategory
              )
              .first(25);

          if (!cats.length) {
            return safeReply(
              interaction,
              'Server chưa có Category.',
              {
                error: true
              }
            );
          }

          const row =
            new ActionRowBuilder()
              .addComponents(
                new StringSelectMenuBuilder()
                  .setCustomId(
                    'setup_category_select'
                  )
                  .setPlaceholder(
                    '📁 Chọn danh mục cho Temp Voice'
                  )
                  .addOptions(
                    cats.map(
                      c => ({
                        label:
                          c.name.slice(
                            0,
                            100
                          ),

                        value:
                          c.id,

                        emoji:
                          '📁'
                      })
                    )
                  )
              );

          return interaction.reply({
            content:
              '**Thiết lập Voice Control** · Chọn danh mục:',

            components: [
              row
            ],

            ephemeral: true
          });
        }

        return;
      }

      // --------------------------------------------
      // String Select Menu
      // --------------------------------------------
      if (
        interaction.isStringSelectMenu()
      ) {
        if (
          interaction.customId ===
          'setup_category_select'
        ) {
          await interaction.deferUpdate();

          const category =
            await interaction.guild
              .channels
              .fetch(
                interaction.values[0]
              )
              .catch(() => null);

          if (
            !category ||
            category.type !==
              ChannelType.GuildCategory
          ) {
            throw new Error(
              'Category không hợp lệ'
            );
          }

          let generator =
            category.children.cache
              .find(
                c =>
                  c.name ===
                    DEFAULT_GENERATOR &&
                  c.type ===
                    ChannelType.GuildVoice
              );

          if (!generator) {
            generator =
              await interaction.guild
                .channels
                .create({
                  name:
                    DEFAULT_GENERATOR,

                  type:
                    ChannelType.GuildVoice,

                  parent:
                    category.id
                });
          }

          let blog =
            category.children.cache
              .find(
                c =>
                  c.name ===
                    FIXED_BLOG_NAME &&
                  c.type ===
                    ChannelType.GuildText
              );

          if (!blog) {
            blog =
              await interaction.guild
                .channels
                .create({
                  name:
                    FIXED_BLOG_NAME,

                  type:
                    ChannelType.GuildText,

                  parent:
                    category.id
                });
          }

          await saveGenerator(
            interaction.guild.id,
            category.id,
            generator.id,
            blog.id
          );

          await interaction.editReply({
            content:
              '✅ **Cài đặt hoàn tất**\n' +
              `🔊 Tạo phòng: ${generator}\n` +
              `🧾 Nhật ký: ${blog}`,

            components: []
          });

          return;
        }

        if (
          interaction.customId ===
          'vc_region_select'
        ) {
          const {
            channel
          } =
            await requireRoomInteraction(
              interaction,
              true
            );

          if (
            !checkCooldown(
              interaction.user.id,
              'region'
            )
          ) {
            return safeReply(
              interaction,
              'Thao tác quá nhanh, thử lại sau một giây.',
              {
                error: true,
                ttl: 1600
              }
            );
          }

          await safeDeferUpdate(
            interaction
          );

          const selected =
            interaction.values[0];

          const finalRegion =
            await setRoomRegion(
              channel,
              selected
            );

          await refreshPanel(
            channel,
            interaction.message
          );

          await sendBlogLog(
            interaction.guild,
            'KHU VỰC',
            `${interaction.user.tag} → ` +
            `${finalRegion || 'Automatic'}`
          );

          return safeReply(
            interaction,
            `Khu vực thoại: **${
              finalRegion ||
              'Tự động'
            }**.`
          );
        }
      }

      // --------------------------------------------
      // User Select Menu
      // --------------------------------------------
      if (
        interaction.isUserSelectMenu()
      ) {
        const {
          channel
        } =
          await requireRoomInteraction(
            interaction,
            true
          );

        const target =
          await interaction.guild
            .members
            .fetch(
              interaction.values[0]
            )
            .catch(() => null);

        if (
          !target ||
          target.user.bot
        ) {
          return safeReply(
            interaction,
            'Thành viên không hợp lệ.',
            {
              error: true
            }
          );
        }

        if (
          target.id ===
            interaction.user.id &&
          interaction.customId !==
            'vc_user_allow'
        ) {
          return safeReply(
            interaction,
            'Bạn không thể áp dụng thao tác này cho chính mình.',
            {
              error: true
            }
          );
        }

        await safeDeferUpdate(
          interaction
        );

        await ensureBotRoomPermissions(
          channel
        );

        if (
          interaction.customId ===
          'vc_user_allow'
        ) {
          await channel
            .permissionOverwrites
            .edit(
              target,
              {
                ViewChannel: true,
                Connect: true
              },
              {
                reason:
                  `TempVoice allow by ${interaction.user.tag}`
              }
            );

          await sendBlogLog(
            interaction.guild,
            'CHO PHÉP',
            `${interaction.user.tag} → ${target.user.tag}`
          );

          return safeReply(
            interaction,
            `Đã cho phép **${target.displayName}** vào phòng.`
          );
        }

        if (
          interaction.customId ===
          'vc_user_deny'
        ) {
          await channel
            .permissionOverwrites
            .edit(
              target,
              {
                ViewChannel: null,
                Connect: false
              },
              {
                reason:
                  `TempVoice deny by ${interaction.user.tag}`
              }
            );

          if (
            target.voice.channelId ===
            channel.id
          ) {
            await target.voice.disconnect(
              'TempVoice: bị chủ phòng cấm'
            );
          }

          await sendBlogLog(
            interaction.guild,
            'CẤM',
            `${interaction.user.tag} → ${target.user.tag}`
          );

          await refreshPanel(
            channel
          );

          return safeReply(
            interaction,
            `Đã cấm **${target.displayName}** khỏi phòng.`
          );
        }

        if (
          interaction.customId ===
          'vc_user_kick'
        ) {
          if (
            target.voice.channelId !==
            channel.id
          ) {
            return safeReply(
              interaction,
              'Thành viên này không ở trong phòng của bạn.',
              {
                error: true
              }
            );
          }

          await target.voice.disconnect(
            'TempVoice: chủ phòng mời rời'
          );

          await sendBlogLog(
            interaction.guild,
            'ĐUỔI',
            `${interaction.user.tag} → ${target.user.tag}`
          );

          await refreshPanel(
            channel
          );

          return safeReply(
            interaction,
            `Đã mời **${target.displayName}** rời phòng.`
          );
        }

        if (
          interaction.customId ===
          'vc_user_transfer'
        ) {
          if (
            target.voice.channelId !==
            channel.id
          ) {
            return safeReply(
              interaction,
              'Người nhận phải đang ở trong phòng.',
              {
                error: true
              }
            );
          }

          await transferOwner(
            channel,
            target
          );

          await sendBlogLog(
            interaction.guild,
            'CHUYỂN CHỦ',
            `${interaction.user.tag} → ${target.user.tag}`
          );

          await refreshPanel(
            channel
          );

          return safeReply(
            interaction,
            `Đã chuyển chủ phòng cho **${target.displayName}**.`
          );
        }

        return;
      }

            // --------------------------------------------
      // Buttons
      // --------------------------------------------
      if (
        interaction.isButton()
      ) {
        const {
          channel,
          room
        } =
          await requireRoomInteraction(
            interaction,
            false
          );

        const owner =
          String(room.owner_id) ===
          interaction.user.id;

        // ------------------------------
        // CLAIM OWNER
        // ------------------------------
        if (
          interaction.customId ===
          'vc_claim'
        ) {
          const oldOwner =
            await interaction.guild
              .members
              .fetch(
                String(room.owner_id)
              )
              .catch(() => null);

          if (
            oldOwner?.voice.channelId ===
            channel.id
          ) {
            return safeReply(
              interaction,
              'Chủ phòng vẫn đang ở trong phòng.',
              {
                error: true
              }
            );
          }

          await safeDeferUpdate(
            interaction
          );

          await transferOwner(
            channel,
            interaction.member
          );

          await refreshPanel(
            channel,
            interaction.message
          );

          await sendBlogLog(
            interaction.guild,
            'NHẬN CHỦ',
            interaction.user.tag
          );

          return safeReply(
            interaction,
            'Bạn đã nhận quyền chủ phòng.'
          );
        }

        // ------------------------------
        // NON OWNER
        // ------------------------------
        if (!owner) {
          const oldOwner =
            await interaction.guild
              .members
              .fetch(
                String(room.owner_id)
              )
              .catch(() => null);

          if (
            !oldOwner ||
            oldOwner.voice.channelId !==
              channel.id
          ) {
            const claimRow =
              new ActionRowBuilder()
                .addComponents(
                  new ButtonBuilder()
                    .setCustomId(
                      'vc_claim'
                    )
                    .setLabel(
                      'Nhận phòng'
                    )
                    .setEmoji('👑')
                    .setStyle(
                      ButtonStyle.Success
                    )
                );

            return interaction.reply({
              content:
                '👑 Chủ phòng hiện không còn ở đây.\nBạn có thể nhận quyền điều khiển phòng.',

              components: [
                claimRow
              ],

              ephemeral: true
            });
          }

          return safeReply(
            interaction,
            'Chỉ chủ phòng mới dùng được chức năng này.',
            {
              error: true
            }
          );
        }

        if (
          !checkCooldown(
            interaction.user.id,
            interaction.customId
          )
        ) {
          return safeReply(
            interaction,
            'Thao tác quá nhanh.',
            {
              error: true,
              ttl: 1500
            }
          );
        }

        // ------------------------------
        // LOCK / UNLOCK
        // ------------------------------
        if (
          interaction.customId ===
          'vc_lock'
        ) {
          await safeDeferUpdate(
            interaction
          );

          await setRoomLocked(
            channel,
            true
          );

          await refreshPanel(
            channel,
            interaction.message
          );

          await sendBlogLog(
            interaction.guild,
            'KHÓA',
            interaction.user.tag
          );

          return safeReply(
            interaction,
            'Đã khóa phòng.'
          );
        }

        if (
          interaction.customId ===
          'vc_unlock'
        ) {
          await safeDeferUpdate(
            interaction
          );

          await setRoomLocked(
            channel,
            false
          );

          await refreshPanel(
            channel,
            interaction.message
          );

          await sendBlogLog(
            interaction.guild,
            'MỞ',
            interaction.user.tag
          );

          return safeReply(
            interaction,
            'Đã mở phòng.'
          );
        }

        // ------------------------------
        // HIDE / SHOW
        // ------------------------------
        if (
          interaction.customId ===
          'vc_hide'
        ) {
          await safeDeferUpdate(
            interaction
          );

          await setRoomHidden(
            channel,
            true
          );

          await refreshPanel(
            channel,
            interaction.message
          );

          await sendBlogLog(
            interaction.guild,
            'ẨN',
            interaction.user.tag
          );

          return safeReply(
            interaction,
            'Đã ẩn phòng.'
          );
        }

        if (
          interaction.customId ===
          'vc_unhide'
        ) {
          await safeDeferUpdate(
            interaction
          );

          await setRoomHidden(
            channel,
            false
          );

          await refreshPanel(
            channel,
            interaction.message
          );

          await sendBlogLog(
            interaction.guild,
            'HIỆN',
            interaction.user.tag
          );

          return safeReply(
            interaction,
            'Đã hiện phòng.'
          );
        }

        // ------------------------------
        // RESET ROOM
        // ------------------------------
        if (
          interaction.customId ===
          'vc_reset'
        ) {
          await safeDeferUpdate(
            interaction
          );

          await ensureBotRoomPermissions(
            channel
          );

          await setRoomLocked(
            channel,
            false
          );

          await setRoomHidden(
            channel,
            false
          );

          await channel.setUserLimit(
            0,
            `TempVoice reset by ${interaction.user.tag}`
          );

          await channel.setRTCRegion(
            null,
            `TempVoice reset by ${interaction.user.tag}`
          );

          // Dọn các overwrite phát sinh
          // bởi Allow / Deny.
          //
          // Giữ lại:
          // - @everyone
          // - bot
          // - owner
          const keepIds =
            new Set([
              channel.guild.roles
                .everyone.id,

              channel.guild.members
                .me.id,

              String(
                room.owner_id
              )
            ]);

          for (
            const overwrite of
              channel
                .permissionOverwrites
                .cache
                .values()
          ) {
            if (
              keepIds.has(
                overwrite.id
              )
            ) {
              continue;
            }

            await overwrite.delete(
              'TempVoice: reset permission'
            ).catch(
              e =>
                logError(
                  'RESET_OVERWRITE',
                  e,
                  {
                    channelId:
                      channel.id,

                    overwriteId:
                      overwrite.id
                  }
                )
            );
          }

          await setOwnerAccess(
            channel,
            String(
              room.owner_id
            ),
            true
          );

          await refreshPanel(
            channel,
            interaction.message
          );

          await sendBlogLog(
            interaction.guild,
            'RESET',
            interaction.user.tag
          );

          return safeReply(
            interaction,
            'Đã đưa phòng về cấu hình mặc định.'
          );
        }

        // ------------------------------
        // RENAME MODAL
        // ------------------------------
        if (
          interaction.customId ===
          'vc_rename'
        ) {
          const modal =
            new ModalBuilder()
              .setCustomId(
                'vc_modal_rename'
              )
              .setTitle(
                'Đổi tên phòng'
              );

          const input =
            new TextInputBuilder()
              .setCustomId(
                'name'
              )
              .setLabel(
                'Tên phòng mới'
              )
              .setStyle(
                TextInputStyle.Short
              )
              .setPlaceholder(
                'Ví dụ: Gaming cùng bạn bè'
              )
              .setMinLength(1)
              .setMaxLength(70)
              .setRequired(true);

          modal.addComponents(
            new ActionRowBuilder()
              .addComponents(
                input
              )
          );

          return interaction.showModal(
            modal
          );
        }

        // ------------------------------
        // LIMIT MODAL
        // ------------------------------
        if (
          interaction.customId ===
          'vc_limit'
        ) {
          const modal =
            new ModalBuilder()
              .setCustomId(
                'vc_modal_limit'
              )
              .setTitle(
                'Giới hạn thành viên'
              );

          const input =
            new TextInputBuilder()
              .setCustomId(
                'limit'
              )
              .setLabel(
                'Số người · 0 = không giới hạn'
              )
              .setStyle(
                TextInputStyle.Short
              )
              .setPlaceholder(
                'Ví dụ: 5'
              )
              .setMinLength(1)
              .setMaxLength(2)
              .setRequired(true);

          modal.addComponents(
            new ActionRowBuilder()
              .addComponents(
                input
              )
          );

          return interaction.showModal(
            modal
          );
        }

        // ------------------------------
        // USER SELECT ACTIONS
        // ------------------------------
        const selectors = {
          vc_allow: {
            id:
              'vc_user_allow',

            placeholder:
              'Chọn người được phép vào',

            text:
              'Chọn thành viên muốn cho phép vào phòng.'
          },

          vc_deny: {
            id:
              'vc_user_deny',

            placeholder:
              'Chọn người cần cấm',

            text:
              'Chọn thành viên muốn chặn khỏi phòng.'
          },

          vc_kick: {
            id:
              'vc_user_kick',

            placeholder:
              'Chọn người cần mời ra',

            text:
              'Chọn thành viên đang ở trong phòng.'
          },

          vc_transfer: {
            id:
              'vc_user_transfer',

            placeholder:
              'Chọn chủ phòng mới',

            text:
              'Người nhận phải đang ở trong phòng.'
          }
        };

        const selector =
          selectors[
            interaction.customId
          ];

        if (selector) {
          const row =
            new ActionRowBuilder()
              .addComponents(
                new UserSelectMenuBuilder()
                  .setCustomId(
                    selector.id
                  )
                  .setPlaceholder(
                    selector.placeholder
                  )
                  .setMinValues(1)
                  .setMaxValues(1)
              );

          return interaction.reply({
            content:
              selector.text,

            components: [
              row
            ],

            ephemeral: true
          });
        }

        return;
      }

      // --------------------------------------------
      // Modal Submit
      // --------------------------------------------
      if (
        interaction.isModalSubmit()
      ) {
        const {
          channel
        } =
          await requireRoomInteraction(
            interaction,
            true
          );

        // ------------------------------
        // RENAME
        // ------------------------------
        if (
          interaction.customId ===
          'vc_modal_rename'
        ) {
          let raw =
            interaction.fields
              .getTextInputValue(
                'name'
              )
              .trim()
              .replace(
                /[\r\n\t]+/g,
                ' '
              )
              .replace(
                /\s{2,}/g,
                ' '
              );

          if (!raw) {
            return safeReply(
              interaction,
              'Tên phòng không hợp lệ.',
              {
                error: true
              }
            );
          }

          raw =
            raw.slice(
              0,
              70
            );

          const finalName =
            `${ROOM_PREFIX}${raw}`
              .slice(
                0,
                100
              );

          await channel.setName(
            finalName,
            `TempVoice rename by ${interaction.user.tag}`
          );

          await refreshPanel(
            channel
          );

          await sendBlogLog(
            interaction.guild,
            'ĐỔI TÊN',
            `${interaction.user.tag} → ${raw}`
          );

          return safeReply(
            interaction,
            `Đã đổi tên phòng thành **${raw}**.`
          );
        }

        // ------------------------------
        // MEMBER LIMIT
        // ------------------------------
        if (
          interaction.customId ===
          'vc_modal_limit'
        ) {
          const input =
            interaction.fields
              .getTextInputValue(
                'limit'
              )
              .trim();

          if (
            !/^\d{1,2}$/.test(
              input
            )
          ) {
            return safeReply(
              interaction,
              'Giới hạn phải là số từ **0 đến 99**.',
              {
                error: true
              }
            );
          }

          const value =
            Number(input);

          if (
            !Number.isInteger(
              value
            ) ||
            value < 0 ||
            value > 99
          ) {
            return safeReply(
              interaction,
              'Giới hạn phải là số từ **0 đến 99**.',
              {
                error: true
              }
            );
          }

          await channel.setUserLimit(
            value,
            `TempVoice limit by ${interaction.user.tag}`
          );

          await refreshPanel(
            channel
          );

          await sendBlogLog(
            interaction.guild,
            'GIỚI HẠN',
            `${interaction.user.tag} → ${
              value || '∞'
            }`
          );

          if (value === 0) {
            return safeReply(
              interaction,
              'Đã bỏ giới hạn thành viên.'
            );
          }

          return safeReply(
            interaction,
            `Giới hạn phòng: **${value} người**.`
          );
        }
      }
    } catch (err) {
      logError(
        'INTERACTION',
        err,
        {
          guildId:
            interaction.guildId,

          channelId:
            interaction.channelId,

          userId:
            interaction.user?.id,

          customId:
            interaction.customId,

          command:
            interaction.commandName
        }
      );

      try {
        await safeReply(
          interaction,
          friendlyError(err),
          {
            error: true,
            ttl: 4500
          }
        );
      } catch (_) {}
    }
  }
);

// ============================================================
// 15) GRACEFUL SHUTDOWN
// ============================================================
let shuttingDown = false;

async function shutdown(
  signal
) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(
    `[SHUTDOWN] ${signal}`
  );

  try {
    client.destroy();
  } catch (_) {}

  try {
    await pool.end();
  } catch (_) {}

  process.exit(0);
}

process.once(
  'SIGTERM',
  () => shutdown(
    'SIGTERM'
  )
);

process.once(
  'SIGINT',
  () => shutdown(
    'SIGINT'
  )
);

// ============================================================
// 16) LOGIN
// ============================================================
client.login(
  TOKEN
).catch(
  err => {
    logError(
      'LOGIN',
      err
    );

    process.exit(1);
  }
);
    
