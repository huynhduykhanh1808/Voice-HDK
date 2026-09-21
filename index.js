'use strict';

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
  SlashCommandBuilder
} = require('discord.js');

const { Pool } = require('pg');
const http = require('http');

const BOT_NAME = 'Voice HDK';
const BOT_VERSION = '4.0.0';

const TOKEN = String(
  process.env.DISCORD_TOKEN ||
  process.env.TOKEN ||
  ''
).trim();

const DATABASE_URL = String(
  process.env.DATABASE_URL || ''
).trim();

const PORT = Number(
  process.env.PORT || 10000
);

const ROOM_PREFIX = '🔊・';
const APP_COLOR = 0x5865F2;

const SUCCESS_DELETE_MS = 3000;
const ERROR_DELETE_MS = 4000;
const ACTION_COOLDOWN_MS = 900;
const TRANSFER_TIMEOUT_MS = 60_000;
const SETUP_SESSION_MS = 10 * 60 * 1000;

if (!TOKEN) {
  throw new Error(
    'Thiếu DISCORD_TOKEN trong Environment Variables.'
  );
}

if (!DATABASE_URL) {
  throw new Error(
    'Thiếu DATABASE_URL trong Environment Variables.'
  );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const pool = new Pool({
  connectionString: DATABASE_URL
});

const panelLocks = new Map();
const cooldowns = new Map();
const selectedMembers = new Map();
const pendingTransfers = new Map();
const setupSessions = new Map();

let regionCache = {
  expiresAt: 0,
  regions: []
};

const REQUIRED_BOT_PERMISSIONS = [
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.SendMessages,
  PermissionsBitField.Flags.EmbedLinks,
  PermissionsBitField.Flags.ReadMessageHistory,
  PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.MoveMembers,
  PermissionsBitField.Flags.Connect
];

const PERMISSION_NAMES = new Map([
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
    'Đọc lịch sử tin nhắn'
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

function logError(
  scope,
  error,
  context = {}
) {
  const code =
    error?.code ??
    error?.rawError?.code ??
    'UNKNOWN';

  console.error(
    `[${scope}] code=${code}`,
    context,
    error?.stack || error
  );
}

pool.on('error', error => {
  logError(
    'POSTGRES_POOL',
    error
  );
});

client.on(
  Events.Error,
  error => {
    logError(
      'DISCORD_CLIENT',
      error
    );
  }
);

client.on(
  Events.Warn,
  warning => {
    console.warn(
      '[DISCORD_WARN]',
      warning
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

    setTimeout(
      () => process.exit(1),
      500
    ).unref?.();
  }
);

const healthServer = http.createServer(
  (req, res) => {
    const pathname =
      String(req.url || '/')
        .split('?')[0];

    if (
      req.method !== 'GET' &&
      req.method !== 'HEAD'
    ) {
      res.writeHead(
        405,
        {
          'Content-Type':
            'application/json; charset=utf-8',
          'Cache-Control':
            'no-store'
        }
      );

      return res.end(
        JSON.stringify({
          ok: false,
          error: 'Method Not Allowed'
        })
      );
    }

    if (
      pathname !== '/' &&
      pathname !== '/health'
    ) {
      res.writeHead(
        404,
        {
          'Content-Type':
            'application/json; charset=utf-8',
          'Cache-Control':
            'no-store'
        }
      );

      return res.end(
        JSON.stringify({
          ok: false,
          error: 'Not Found'
        })
      );
    }

    const body = JSON.stringify({
      ok: true,
      service: BOT_NAME,
      version: BOT_VERSION,
      discord: client.isReady(),
      uptime: Math.floor(
        process.uptime()
      )
    });

    res.writeHead(
      200,
      {
        'Content-Type':
          'application/json; charset=utf-8',
        'Cache-Control':
          'no-store'
      }
    );

    if (req.method === 'HEAD') {
      return res.end();
    }

    return res.end(body);
  }
);

healthServer.on(
  'error',
  error => {
    logError(
      'HEALTH_SERVER',
      error
    );

    process.exit(1);
  }
);

healthServer.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `[HEALTH] :${PORT}/health`
    );
  }
);

async function initDatabase() {
  await pool.query('SELECT 1');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS generators (
      guild_id BIGINT PRIMARY KEY,
      category_id BIGINT,
      generator_id BIGINT,
      blog_channel_id BIGINT,
      tracked_text_channel_id BIGINT,
      setup_channel_id BIGINT,
      setup_message_id BIGINT,
      display_name TEXT
    )
  `);

  await pool.query(`
    ALTER TABLE generators
    ADD COLUMN IF NOT EXISTS
    tracked_text_channel_id BIGINT
  `);

  await pool.query(`
    ALTER TABLE generators
    ADD COLUMN IF NOT EXISTS
    setup_channel_id BIGINT
  `);

  await pool.query(`
    ALTER TABLE generators
    ADD COLUMN IF NOT EXISTS
    setup_message_id BIGINT
  `);

  await pool.query(`
    ALTER TABLE generators
    ADD COLUMN IF NOT EXISTS
    display_name TEXT
  `);

  await pool.query(`
    ALTER TABLE generators
    ALTER COLUMN category_id
    DROP NOT NULL
  `).catch(() => {});

  await pool.query(`
    ALTER TABLE generators
    ALTER COLUMN generator_id
    DROP NOT NULL
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      guild_id BIGINT NOT NULL,
      channel_id BIGINT PRIMARY KEY,
      owner_id BIGINT NOT NULL,
      category_id BIGINT,
      control_message_id BIGINT,
      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE rooms
    ADD COLUMN IF NOT EXISTS
    control_message_id BIGINT
  `);

  await pool.query(`
    ALTER TABLE rooms
    ADD COLUMN IF NOT EXISTS
    created_at TIMESTAMPTZ
    DEFAULT NOW()
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    rooms_guild_owner_idx
    ON rooms(guild_id, owner_id)
  `);

  console.log(
    '[DATABASE] PostgreSQL sẵn sàng.'
  );
}

async function getGenerator(
  guildId
) {
  const result = await pool.query(
    `
      SELECT *
      FROM generators
      WHERE guild_id=$1
      LIMIT 1
    `,
    [guildId]
  );

  return result.rows[0] || null;
}

async function saveGenerator({
  guildId,
  categoryId,
  generatorId = null,
  blogChannelId = null,
  trackedTextChannelId = null,
  setupChannelId,
  setupMessageId,
  displayName
}) {
  await pool.query(
    `
      INSERT INTO generators (
        guild_id,
        category_id,
        generator_id,
        blog_channel_id,
        tracked_text_channel_id,
        setup_channel_id,
        setup_message_id,
        display_name
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8
      )

      ON CONFLICT(guild_id)
      DO UPDATE SET
        category_id =
          EXCLUDED.category_id,

        generator_id =
          EXCLUDED.generator_id,

        blog_channel_id =
          COALESCE(
            EXCLUDED.blog_channel_id,
            generators.blog_channel_id
          ),

        tracked_text_channel_id =
          COALESCE(
            EXCLUDED.tracked_text_channel_id,
            generators.tracked_text_channel_id
          ),

        setup_channel_id =
          EXCLUDED.setup_channel_id,

        setup_message_id =
          EXCLUDED.setup_message_id,

        display_name =
          EXCLUDED.display_name
    `,
    [
      guildId,
      categoryId,
      generatorId,
      blogChannelId,
      trackedTextChannelId,
      setupChannelId,
      setupMessageId,
      displayName
    ]
  );
}

async function setTrackedTextChannel(
  guildId,
  channelId
) {
  await pool.query(
    `
      UPDATE generators
      SET tracked_text_channel_id=$1
      WHERE guild_id=$2
    `,
    [
      channelId,
      guildId
    ]
  );
}

async function getRoom(
  channelId
) {
  const result = await pool.query(
    `
      SELECT *
      FROM rooms
      WHERE channel_id=$1
      LIMIT 1
    `,
    [channelId]
  );

  return result.rows[0] || null;
}

async function getOwnedRoom(
  guildId,
  ownerId
) {
  const result = await pool.query(
    `
      SELECT *
      FROM rooms
      WHERE guild_id=$1
        AND owner_id=$2
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [
      guildId,
      ownerId
    ]
  );

  return result.rows[0] || null;
}

async function saveRoom({
  guildId,
  channelId,
  ownerId,
  categoryId,
  controlMessageId = null
}) {
  await pool.query(
    `
      INSERT INTO rooms (
        guild_id,
        channel_id,
        owner_id,
        category_id,
        control_message_id
      )
      VALUES (
        $1,$2,$3,$4,$5
      )

      ON CONFLICT(channel_id)
      DO UPDATE SET
        owner_id =
          EXCLUDED.owner_id,

        category_id =
          EXCLUDED.category_id,

        control_message_id =
          COALESCE(
            EXCLUDED.control_message_id,
            rooms.control_message_id
          )
    `,
    [
      guildId,
      channelId,
      ownerId,
      categoryId,
      controlMessageId
    ]
  );
}

async function setControlMessage(
  channelId,
  messageId
) {
  await pool.query(
    `
      UPDATE rooms
      SET control_message_id=$1
      WHERE channel_id=$2
    `,
    [
      messageId,
      channelId
    ]
  );
}

async function updateRoomOwner(
  channelId,
  oldOwnerId,
  newOwnerId
) {
  const result = await pool.query(
    `
      UPDATE rooms
      SET owner_id=$1
      WHERE channel_id=$2
        AND owner_id=$3
      RETURNING *
    `,
    [
      newOwnerId,
      channelId,
      oldOwnerId
    ]
  );

  return result.rows[0] || null;
}

async function deleteRoomRecord(
  channelId
) {
  clearSelectedMember(
    channelId
  );

  clearPendingTransfer(
    channelId
  );

  await pool.query(
    `
      DELETE FROM rooms
      WHERE channel_id=$1
    `,
    [channelId]
  );
}

function isSnowflake(value) {
  return /^\d{17,20}$/.test(
    String(value || '')
  );
}

function safeDisplayName(
  value,
  maxLength = 32
) {
  const cleaned = String(
    value || ''
  )
    .replace(/[`*_~|]/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return 'Máy chủ';
  }

  if (
    cleaned.length <=
    maxLength
  ) {
    return cleaned;
  }

  return (
    cleaned.slice(
      0,
      Math.max(
        1,
        maxLength - 1
      )
    ) + '…'
  );
}

function safeMemberName(
  member
) {
  return safeDisplayName(
    member?.displayName ||
    member?.user?.globalName ||
    member?.user?.username ||
    'Thành viên',
    24
  );
}

function cleanRoomName(
  value
) {
  const cleaned = String(
    value || ''
  )
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^🔊・/, '')
    .replace(/[\/\\#:@`]/g, '')
    .trim();

  if (!cleaned) {
    return 'Phòng riêng';
  }

  return cleaned.slice(
    0,
    80
  );
}

function vietnamTime(
  date = new Date()
) {
  const parts =
    new Intl.DateTimeFormat(
      'vi-VN',
      {
        timeZone:
          'Asia/Ho_Chi_Minh',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }
    ).formatToParts(date);

  const get = type =>
    parts.find(
      item =>
        item.type === type
    )?.value || '';

  return (
    `${get('hour')}:` +
    `${get('minute')}:` +
    `${get('second')} ` +
    `${get('day')}/` +
    `${get('month')}/` +
    `${get('year')}`
  );
}

function getRoomState(
  channel
) {
  const everyone =
    channel.permissionOverwrites
      .cache
      .get(
        channel.guild.roles
          .everyone.id
      );

  return {
    locked: Boolean(
      everyone?.deny.has(
        PermissionsBitField
          .Flags
          .Connect
      )
    ),

    hidden: Boolean(
      everyone?.deny.has(
        PermissionsBitField
          .Flags
          .ViewChannel
      )
    )
  };
}

function setSelectedMember(
  channelId,
  ownerId,
  targetId
) {
  selectedMembers.set(
    String(channelId),
    {
      ownerId:
        String(ownerId),

      targetId:
        String(targetId)
    }
  );
}

function getSelectedMember(
  channelId,
  ownerId
) {
  const key =
    String(channelId);

  const selected =
    selectedMembers.get(key);

  if (!selected) {
    return null;
  }

  if (
    String(selected.ownerId) !==
    String(ownerId)
  ) {
    selectedMembers.delete(key);
    return null;
  }

  return selected.targetId;
}

function clearSelectedMember(
  channelId
) {
  selectedMembers.delete(
    String(channelId)
  );
}

function clearPendingTransfer(
  channelId
) {
  const key =
    String(channelId);

  const pending =
    pendingTransfers.get(key);

  if (pending?.timer) {
    clearTimeout(
      pending.timer
    );
  }

  pendingTransfers.delete(key);
}

function relativeTimestamp(
  timestamp
) {
  return (
    `<t:${Math.floor(
      timestamp / 1000
    )}:R>`
  );
}

function setupSessionKey(
  guildId,
  userId
) {
  return `${guildId}:${userId}`;
}

function setSetupSession(
  guildId,
  userId,
  data = {}
) {
  setupSessions.set(
    setupSessionKey(
      guildId,
      userId
    ),
    {
      guildId:
        String(guildId),

      userId:
        String(userId),

      channelId:
        data.channelId || null,

      displayName:
        data.displayName || null,

      expiresAt:
        Date.now() +
        SETUP_SESSION_MS
    }
  );
}

function getSetupSession(
  guildId,
  userId
) {
  const key =
    setupSessionKey(
      guildId,
      userId
    );

  const session =
    setupSessions.get(key);

  if (!session) {
    return null;
  }

  if (
    session.expiresAt <
    Date.now()
  ) {
    setupSessions.delete(key);
    return null;
  }

  return session;
}

function clearSetupSession(
  guildId,
  userId
) {
  setupSessions.delete(
    setupSessionKey(
      guildId,
      userId
    )
  );
}

function useCooldown(
  userId,
  action
) {
  const key =
    `${userId}:${action}`;

  const now =
    Date.now();

  const until =
    cooldowns.get(key) || 0;

  if (until > now) {
    return false;
  }

  cooldowns.set(
    key,
    now +
    ACTION_COOLDOWN_MS
  );

  return true;
}

async function withPanelLock(
  channelId,
  task
) {
  const key =
    String(channelId);

  const previous =
    panelLocks.get(key) ||
    Promise.resolve();

  let release;

  const current =
    new Promise(resolve => {
      release = resolve;
    });

  panelLocks.set(
    key,
    current
  );

  await previous.catch(
    () => {}
  );

  try {
    return await task();
  } finally {
    release();

    if (
      panelLocks.get(key) ===
      current
    ) {
      panelLocks.delete(key);
    }
  }
}

function getMissingPermissions(
  guild,
  channel = null
) {
  const me =
    guild.members.me;

  if (!me) {
    return [
      ...REQUIRED_BOT_PERMISSIONS
    ];
  }

  const permissions =
    channel
      ? channel.permissionsFor(me)
      : me.permissions;

  return REQUIRED_BOT_PERMISSIONS
    .filter(
      permission =>
        !permissions?.has(
          permission
        )
    );
}

function permissionNames(
  permissions
) {
  return permissions.map(
    permission =>
      PERMISSION_NAMES.get(
        permission
      ) ||
      String(permission)
  );
}
async function deleteReplyLater(
  interaction,
  delay = SUCCESS_DELETE_MS
) {
  const timer = setTimeout(
    async () => {
      try {
        await interaction.deleteReply();
      } catch {}
    },
    delay
  );

  timer.unref?.();
}

async function tempReply(
  interaction,
  content,
  {
    error = false,
    delay = null
  } = {}
) {
  const deleteAfter =
    delay ??
    (
      error
        ? ERROR_DELETE_MS
        : SUCCESS_DELETE_MS
    );

  try {
    if (interaction.deferred) {
      await interaction.editReply({
        content,
        components: []
      });

      deleteReplyLater(
        interaction,
        deleteAfter
      );

      return;
    }

    if (interaction.replied) {
      const message =
        await interaction.followUp({
          content,
          ephemeral: true,
          fetchReply: true
        });

      const timer = setTimeout(
        () => {
          message
            .delete()
            .catch(() => {});
        },
        deleteAfter
      );

      timer.unref?.();
      return;
    }

    await interaction.reply({
      content,
      ephemeral: true
    });

    deleteReplyLater(
      interaction,
      deleteAfter
    );
  } catch (errorReply) {
    logError(
      'TEMP_REPLY',
      errorReply,
      {
        interactionId:
          interaction?.id,

        customId:
          interaction?.customId
      }
    );
  }
}

async function tempFollowUp(
  interaction,
  content,
  {
    error = false,
    delay = null
  } = {}
) {
  const deleteAfter =
    delay ??
    (
      error
        ? ERROR_DELETE_MS
        : SUCCESS_DELETE_MS
    );

  try {
    const message =
      await interaction.followUp({
        content,
        ephemeral: true,
        fetchReply: true
      });

    const timer = setTimeout(
      () => {
        message
          .delete()
          .catch(() => {});
      },
      deleteAfter
    );

    timer.unref?.();

    return message;
  } catch (errorFollowUp) {
    logError(
      'TEMP_FOLLOWUP',
      errorFollowUp,
      {
        interactionId:
          interaction?.id,

        customId:
          interaction?.customId
      }
    );

    return null;
  }
}

async function ensureBotRoomPermissions(
  channel
) {
  const me =
    channel.guild.members.me ||
    await channel.guild.members
      .fetchMe();

  if (!me) {
    throw new Error(
      'Không tìm thấy thành viên bot trong máy chủ.'
    );
  }

  await channel.permissionOverwrites.edit(
    me.id,
    {
      ViewChannel: true,
      Connect: true,
      SendMessages: true,
      EmbedLinks: true,
      ReadMessageHistory: true,
      ManageChannels: true,
      ManageRoles: true,
      MoveMembers: true
    }
  );
}

async function grantOwnerPermissions(
  channel,
  ownerId
) {
  if (!isSnowflake(ownerId)) {
    throw new TypeError(
      'ID chủ phòng không hợp lệ.'
    );
  }

  await channel.permissionOverwrites.edit(
    ownerId,
    {
      ViewChannel: true,
      Connect: true,
      Speak: true,
      Stream: true,
      UseVAD: true,
      SendMessages: true,
      ReadMessageHistory: true
    }
  );
}

async function removeOwnerPermissions(
  channel,
  ownerId
) {
  if (!isSnowflake(ownerId)) {
    return;
  }

  await channel.permissionOverwrites
    .delete(ownerId)
    .catch(error => {
      logError(
        'REMOVE_OWNER_PERMISSIONS',
        error,
        {
          channelId:
            channel.id,

          ownerId
        }
      );
    });
}

async function setRoomLocked(
  channel,
  locked
) {
  await channel.permissionOverwrites.edit(
    channel.guild.roles.everyone.id,
    {
      Connect:
        locked
          ? false
          : null
    }
  );
}

async function setRoomHidden(
  channel,
  hidden
) {
  await channel.permissionOverwrites.edit(
    channel.guild.roles.everyone.id,
    {
      ViewChannel:
        hidden
          ? false
          : null
    }
  );
}

async function inviteMember(
  channel,
  member
) {
  if (
    !member ||
    !isSnowflake(member.id)
  ) {
    throw new Error(
      'Thành viên được mời không hợp lệ.'
    );
  }

  if (member.user?.bot) {
    throw new Error(
      'Không thể mời bot vào phòng.'
    );
  }

  await channel.permissionOverwrites.edit(
    member.id,
    {
      ViewChannel: true,
      Connect: true
    }
  );

  const freshChannel =
    await channel.guild.channels
      .fetch(channel.id);

  if (!freshChannel) {
    throw new Error(
      'Không thể xác minh phòng sau khi mời.'
    );
  }

  const overwrite =
    freshChannel.permissionOverwrites
      .cache
      .get(member.id);

  const canView =
    overwrite?.allow.has(
      PermissionsBitField.Flags.ViewChannel
    );

  const canConnect =
    overwrite?.allow.has(
      PermissionsBitField.Flags.Connect
    );

  if (
    !canView ||
    !canConnect
  ) {
    throw new Error(
      'Discord chưa áp dụng đầy đủ quyền mời.'
    );
  }
}

async function denyMember(
  channel,
  member
) {
  if (
    !member ||
    !isSnowflake(member.id)
  ) {
    throw new Error(
      'Thành viên cần cấm không hợp lệ.'
    );
  }

  await channel.permissionOverwrites.edit(
    member.id,
    {
      ViewChannel: false,
      Connect: false
    }
  );

  if (
    member.voice.channelId ===
    channel.id
  ) {
    await member.voice.disconnect(
      `Bị cấm khỏi ${channel.name}`
    );
  }
}

async function kickMember(
  channel,
  member
) {
  if (
    !member ||
    !isSnowflake(member.id)
  ) {
    throw new Error(
      'Thành viên cần đuổi không hợp lệ.'
    );
  }

  if (
    member.voice.channelId !==
    channel.id
  ) {
    throw new Error(
      'Thành viên không còn ở trong phòng.'
    );
  }

  await member.voice.disconnect(
    `Bị đuổi khỏi ${channel.name}`
  );
}

async function resetRoom(
  channel,
  ownerId
) {
  await setRoomLocked(
    channel,
    false
  );

  await setRoomHidden(
    channel,
    false
  );

  await channel.setUserLimit(0);
  await channel.setRTCRegion(null);

  const protectedIds =
    new Set([
      String(
        channel.guild.roles.everyone.id
      ),
      String(ownerId),
      String(client.user.id)
    ]);

  const overwrites = [
    ...channel.permissionOverwrites
      .cache.values()
  ];

  for (
    const overwrite
    of overwrites
  ) {
    if (
      protectedIds.has(
        String(overwrite.id)
      )
    ) {
      continue;
    }

    try {
      await channel.permissionOverwrites
        .delete(overwrite.id);
    } catch (error) {
      logError(
        'RESET_OVERWRITE',
        error,
        {
          channelId:
            channel.id,

          overwriteId:
            overwrite.id
        }
      );
    }
  }

  await grantOwnerPermissions(
    channel,
    ownerId
  );

  clearSelectedMember(
    channel.id
  );

  clearPendingTransfer(
    channel.id
  );
}

async function getVoiceRegions(
  force = false
) {
  const now =
    Date.now();

  if (
    !force &&
    regionCache.regions.length &&
    regionCache.expiresAt > now
  ) {
    return regionCache.regions;
  }

  const collection =
    await client.fetchVoiceRegions();

  const regions = [
    ...collection.values()
  ]
    .filter(
      region =>
        !region.deprecated
    )
    .sort(
      (a, b) =>
        String(
          a.name || a.id
        ).localeCompare(
          String(
            b.name || b.id
          ),
          'vi'
        )
    );

  regionCache = {
    expiresAt:
      now +
      30 * 60 * 1000,

    regions
  };

  return regions;
}

function getRegionLabel(
  channel,
  regions
) {
  if (!channel.rtcRegion) {
    return 'Tự động';
  }

  const region =
    regions.find(
      item =>
        item.id ===
        channel.rtcRegion
    );

  return safeDisplayName(
    region?.name ||
    channel.rtcRegion,
    24
  );
}

function getPanelColor(
  locked,
  hidden
) {
  if (
    locked &&
    hidden
  ) {
    return 0xED4245;
  }

  if (
    locked ||
    hidden
  ) {
    return 0xFEE75C;
  }

  return 0x57F287;
}

function makePanelDashboard({
  channel,
  owner,
  generator,
  regionLabel
}) {
  const {
    locked,
    hidden
  } = getRoomState(channel);

  const ownerName =
    safeMemberName(owner)
      .toUpperCase();

  const memberCount =
    channel.members.filter(
      member =>
        !member.user.bot
    ).size;

  const limit =
    channel.userLimit > 0
      ? String(channel.userLimit)
      : 'Không giới hạn';

  const roomStatus =
    locked
      ? 'Đã khóa'
      : 'Đang mở';

  const visibility =
    hidden
      ? 'Đang ẩn'
      : 'Công khai';

  const serverLabel =
    safeDisplayName(
      generator?.display_name ||
      channel.guild.name,
      26
    );

  return [
    `🔊  PHÒNG CỦA ${ownerName}`,
    '────────────────────────────',
    `👑 Chủ phòng    ${safeMemberName(owner)}`,
    `👥 Thành viên   ${memberCount} / ${limit}`,
    `🔓 Phòng        ${roomStatus}`,
    `👁 Hiển thị     ${visibility}`,
    `🌐 Khu vực      ${regionLabel}`,
    '────────────────────────────',
    `✦ Voice HDK • ${serverLabel}`
  ].join('\n');
}

async function buildRoomPanel(
  channel,
  room
) {
  const owner =
    await channel.guild.members
      .fetch(room.owner_id)
      .catch(() => null);

  if (!owner) {
    throw new Error(
      'Không tìm thấy chủ phòng.'
    );
  }

  const generator =
    await getGenerator(
      channel.guild.id
    );

  let regions = [];

  try {
    regions =
      await getVoiceRegions();
  } catch (error) {
    logError(
      'VOICE_REGIONS_PANEL',
      error,
      {
        channelId:
          channel.id
      }
    );
  }

  const regionLabel =
    getRegionLabel(
      channel,
      regions
    );

  const {
    locked,
    hidden
  } = getRoomState(channel);

  const dashboard =
    makePanelDashboard({
      channel,
      owner,
      generator,
      regionLabel
    });

  const embed =
    new EmbedBuilder()
      .setColor(
        getPanelColor(
          locked,
          hidden
        )
      )
      .setDescription(
        `\`\`\`\n${dashboard}\n\`\`\``
      )
      .setThumbnail(
        owner.displayAvatarURL({
          size: 128
        })
      );

  const row1 =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            locked
              ? 'vc_unlock'
              : 'vc_lock'
          )
          .setLabel(
            locked
              ? 'Mở'
              : 'Khóa'
          )
          .setEmoji(
            locked
              ? '🔓'
              : '🔒'
          )
          .setStyle(
            locked
              ? ButtonStyle.Success
              : ButtonStyle.Secondary
          ),

        new ButtonBuilder()
          .setCustomId(
            hidden
              ? 'vc_show'
              : 'vc_hide'
          )
          .setLabel(
            hidden
              ? 'Hiện'
              : 'Ẩn'
          )
          .setEmoji(
            hidden
              ? '👁️'
              : '🙈'
          )
          .setStyle(
            hidden
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
            ButtonStyle.Secondary
          )
      );

  const row2 =
    new ActionRowBuilder()
      .addComponents(
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
            ButtonStyle.Secondary
          ),

        new ButtonBuilder()
          .setCustomId(
            'vc_invite'
          )
          .setLabel(
            'Mời'
          )
          .setEmoji('✉️')
          .setStyle(
            ButtonStyle.Primary
          )
      );

  const row3 =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'vc_transfer'
          )
          .setLabel(
            'Chuyển chủ'
          )
          .setEmoji('👑')
          .setStyle(
            ButtonStyle.Secondary
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
          )
      );

  const memberMenu =
    new UserSelectMenuBuilder()
      .setCustomId(
        'vc_member_select'
      )
      .setPlaceholder(
        'Chọn thành viên'
      )
      .setMinValues(1)
      .setMaxValues(1);

  const row4 =
    new ActionRowBuilder()
      .addComponents(
        memberMenu
      );

  const regionOptions = [
    {
      label: 'Tự động',
      value: 'automatic',
      emoji: '🌐',
      default:
        !channel.rtcRegion
    }
  ];

  for (
    const region
    of regions.slice(0, 24)
  ) {
    regionOptions.push({
      label:
        safeDisplayName(
          region.name ||
          region.id,
          80
        ),

      value:
        region.id,

      default:
        channel.rtcRegion ===
        region.id
    });
  }

  const regionMenu =
    new StringSelectMenuBuilder()
      .setCustomId(
        'vc_region'
      )
      .setPlaceholder(
        `🌐 ${regionLabel}`
      )
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        regionOptions
      );

  const row5 =
    new ActionRowBuilder()
      .addComponents(
        regionMenu
      );

  return {
    embeds: [embed],

    components: [
      row1,
      row2,
      row3,
      row4,
      row5
    ]
  };
}

function isRoomPanelMessage(
  message
) {
  if (
    !message ||
    message.author?.id !==
      client.user?.id
  ) {
    return false;
  }

  const customIds =
    message.components
      ?.flatMap(
        row =>
          row.components || []
      )
      .map(
        component =>
          component.customId
      )
      .filter(Boolean) || [];

  return (
    customIds.includes(
      'vc_member_select'
    ) &&
    customIds.includes(
      'vc_region'
    ) &&
    (
      customIds.includes(
        'vc_lock'
      ) ||
      customIds.includes(
        'vc_unlock'
      )
    )
  );
}

async function findExistingPanel(
  channel,
  room
) {
  if (
    room.control_message_id
  ) {
    const stored =
      await channel.messages
        .fetch(
          room.control_message_id
        )
        .catch(() => null);

    if (
      stored &&
      isRoomPanelMessage(stored)
    ) {
      return stored;
    }
  }

  const recent =
    await channel.messages
      .fetch({
        limit: 50
      })
      .catch(() => null);

  if (!recent) {
    return null;
  }

  const panels = [
    ...recent.values()
  ]
    .filter(
      isRoomPanelMessage
    )
    .sort(
      (a, b) =>
        b.createdTimestamp -
        a.createdTimestamp
    );

  if (!panels.length) {
    return null;
  }

  const newest =
    panels[0];

  for (
    const duplicate
    of panels.slice(1)
  ) {
    await duplicate
      .delete()
      .catch(() => {});
  }

  if (
    String(
      room.control_message_id ||
      ''
    ) !==
    String(newest.id)
  ) {
    await setControlMessage(
      channel.id,
      newest.id
    );
  }

  return newest;
}

async function refreshRoomPanel(
  channelId
) {
  return withPanelLock(
    channelId,
    async () => {
      const room =
        await getRoom(
          channelId
        );

      if (!room) {
        return null;
      }

      const channel =
        await client.channels
          .fetch(channelId)
          .catch(() => null);

      if (
        !channel ||
        channel.type !==
          ChannelType.GuildVoice
      ) {
        return null;
      }

      const payload =
        await buildRoomPanel(
          channel,
          room
        );

      let panel =
        await findExistingPanel(
          channel,
          room
        );

      if (panel) {
        try {
          panel =
            await panel.edit(
              payload
            );

          return panel;
        } catch (error) {
          logError(
            'PANEL_EDIT',
            error,
            {
              channelId
            }
          );
        }
      }

      panel =
        await channel.send(
          payload
        );

      await setControlMessage(
        channel.id,
        panel.id
      );

      return panel;
    }
  );
}

async function refreshRoomPanelSafe(
  channelId
) {
  try {
    return await refreshRoomPanel(
      channelId
    );
  } catch (error) {
    logError(
      'PANEL_REFRESH',
      error,
      {
        channelId
      }
    );

    return null;
  }
}
function buildSetupPanel(
  session
) {
  const selectedChannel =
    session?.channelId
      ? `<#${session.channelId}>`
      : 'Chưa chọn';

  const displayName =
    session?.displayName
      ? safeDisplayName(
          session.displayName,
          32
        )
      : 'Chưa đặt';

  const embed =
    new EmbedBuilder()
      .setColor(APP_COLOR)
      .setTitle(
        '⚙️ Thiết lập Voice HDK'
      )
      .setDescription(
        [
          'Chọn kênh để đặt nút **Tạo phòng**.',
          '',
          `📍 Kênh: ${selectedChannel}`,
          `🏷️ Tên panel: **${displayName}**`,
          '',
          'Tên panel chỉ xuất hiện trong phòng thoại.',
          'Nút tạo phòng vẫn luôn hiển thị **➕ Tạo phòng**.'
        ].join('\n')
      );

  const channelSelect =
    new ChannelSelectMenuBuilder()
      .setCustomId(
        'setup_channel'
      )
      .setPlaceholder(
        'Chọn kênh đặt nút Tạo phòng'
      )
      .setChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement
      )
      .setMinValues(1)
      .setMaxValues(1);

  const channelRow =
    new ActionRowBuilder()
      .addComponents(
        channelSelect
      );

  const nameButton =
    new ButtonBuilder()
      .setCustomId(
        'setup_name'
      )
      .setLabel(
        session?.displayName
          ? 'Đổi tên'
          : 'Đặt tên'
      )
      .setEmoji('✏️')
      .setStyle(
        ButtonStyle.Secondary
      );

  const confirmButton =
    new ButtonBuilder()
      .setCustomId(
        'setup_confirm'
      )
      .setLabel(
        'Hoàn tất'
      )
      .setEmoji('✅')
      .setStyle(
        ButtonStyle.Success
      )
      .setDisabled(
        !session?.channelId ||
        !session?.displayName
      );

  const buttonRow =
    new ActionRowBuilder()
      .addComponents(
        nameButton,
        confirmButton
      );

  return {
    embeds: [embed],
    components: [
      channelRow,
      buttonRow
    ]
  };
}

function buildCreateRoomPanel() {
  const embed =
    new EmbedBuilder()
      .setColor(APP_COLOR)
      .setTitle(
        '🔊 Tạo phòng thoại'
      )
      .setDescription(
        [
          'Tạo một phòng thoại riêng dành cho bạn.',
          '',
          'Phòng sẽ tự động được quản lý bởi **Voice HDK**.'
        ].join('\n')
      );

  const createButton =
    new ButtonBuilder()
      .setCustomId(
        'voice_create'
      )
      .setLabel(
        'Tạo phòng'
      )
      .setEmoji('➕')
      .setStyle(
        ButtonStyle.Primary
      );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder()
        .addComponents(
          createButton
        )
    ]
  };
}

async function handleSetupCommand(
  interaction
) {
  if (!interaction.guild) {
    return tempReply(
      interaction,
      '❌ Lệnh này chỉ dùng trong máy chủ.',
      {
        error: true
      }
    );
  }

  if (
    !interaction.memberPermissions?.has(
      PermissionsBitField.Flags.ManageGuild
    )
  ) {
    return tempReply(
      interaction,
      '⛔ Bạn cần quyền Quản lý máy chủ để thiết lập Voice HDK.',
      {
        error: true
      }
    );
  }

  const missing =
    getMissingPermissions(
      interaction.guild
    );

  if (missing.length) {
    return tempReply(
      interaction,
      '❌ Voice HDK đang thiếu quyền: ' +
      permissionNames(
        missing
      ).join(', '),
      {
        error: true,
        delay: 8000
      }
    );
  }

  const current =
    await getGenerator(
      interaction.guild.id
    );

  setSetupSession(
    interaction.guild.id,
    interaction.user.id,
    {
      channelId:
        current?.setup_channel_id ||
        null,

      displayName:
        current?.display_name ||
        null
    }
  );

  const session =
    getSetupSession(
      interaction.guild.id,
      interaction.user.id
    );

  await interaction.reply({
    ...buildSetupPanel(
      session
    ),
    ephemeral: true
  });
}

async function handleSetupChannelSelect(
  interaction
) {
  if (!interaction.guild) {
    return;
  }

  if (
    !interaction.memberPermissions?.has(
      PermissionsBitField.Flags.ManageGuild
    )
  ) {
    return tempReply(
      interaction,
      '⛔ Bạn không có quyền thiết lập.',
      {
        error: true
      }
    );
  }

  let session =
    getSetupSession(
      interaction.guild.id,
      interaction.user.id
    );

  if (!session) {
    setSetupSession(
      interaction.guild.id,
      interaction.user.id
    );

    session =
      getSetupSession(
        interaction.guild.id,
        interaction.user.id
      );
  }

  const channelId =
    interaction.values?.[0];

  const channel =
    await interaction.guild.channels
      .fetch(channelId)
      .catch(() => null);

  if (
    !channel ||
    (
      channel.type !==
        ChannelType.GuildText &&
      channel.type !==
        ChannelType.GuildAnnouncement
    )
  ) {
    return tempReply(
      interaction,
      '❌ Kênh đã chọn không hợp lệ.',
      {
        error: true
      }
    );
  }

  const me =
    interaction.guild.members.me ||
    await interaction.guild.members
      .fetchMe();

  const permissions =
    channel.permissionsFor(me);

  const required = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.EmbedLinks,
    PermissionsBitField.Flags.ReadMessageHistory
  ];

  const missing =
    required.filter(
      permission =>
        !permissions?.has(
          permission
        )
    );

  if (missing.length) {
    return tempReply(
      interaction,
      '❌ Voice HDK thiếu quyền trong kênh này: ' +
      permissionNames(
        missing
      ).join(', '),
      {
        error: true
      }
    );
  }

  session.channelId =
    channel.id;

  session.expiresAt =
    Date.now() +
    SETUP_SESSION_MS;

  setupSessions.set(
    setupSessionKey(
      interaction.guild.id,
      interaction.user.id
    ),
    session
  );

  await interaction.update(
    buildSetupPanel(
      session
    )
  );
}

async function showSetupNameModal(
  interaction
) {
  if (!interaction.guild) {
    return;
  }

  let session =
    getSetupSession(
      interaction.guild.id,
      interaction.user.id
    );

  if (!session) {
    setSetupSession(
      interaction.guild.id,
      interaction.user.id
    );

    session =
      getSetupSession(
        interaction.guild.id,
        interaction.user.id
      );
  }

  const input =
    new TextInputBuilder()
      .setCustomId(
        'setup_display_name'
      )
      .setLabel(
        'Tên hiển thị trong panel'
      )
      .setPlaceholder(
        'Ví dụ: Khủng Long Con'
      )
      .setStyle(
        TextInputStyle.Short
      )
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(32);

  if (session.displayName) {
    input.setValue(
      safeDisplayName(
        session.displayName,
        32
      )
    );
  }

  const modal =
    new ModalBuilder()
      .setCustomId(
        'setup_name_modal'
      )
      .setTitle(
        'Tên hiển thị Voice HDK'
      )
      .addComponents(
        new ActionRowBuilder()
          .addComponents(input)
      );

  await interaction.showModal(
    modal
  );
}

async function handleSetupNameModal(
  interaction
) {
  if (!interaction.guild) {
    return;
  }

  const rawName =
    interaction.fields
      .getTextInputValue(
        'setup_display_name'
      );

  const displayName =
    safeDisplayName(
      rawName,
      32
    );

  if (
    !displayName ||
    displayName === 'Máy chủ'
  ) {
    return tempReply(
      interaction,
      '❌ Tên hiển thị không hợp lệ.',
      {
        error: true
      }
    );
  }

  let session =
    getSetupSession(
      interaction.guild.id,
      interaction.user.id
    );

  if (!session) {
    setSetupSession(
      interaction.guild.id,
      interaction.user.id,
      {
        displayName
      }
    );

    session =
      getSetupSession(
        interaction.guild.id,
        interaction.user.id
      );
  } else {
    session.displayName =
      displayName;

    session.expiresAt =
      Date.now() +
      SETUP_SESSION_MS;

    setupSessions.set(
      setupSessionKey(
        interaction.guild.id,
        interaction.user.id
      ),
      session
    );
  }

  await interaction.reply({
    content:
      `✅ Tên panel: **${displayName}**`,
    ephemeral: true
  });

  deleteReplyLater(
    interaction,
    SUCCESS_DELETE_MS
  );
}

async function findOrCreateVoiceCategory(
  guild,
  current
) {
  if (
    current?.category_id
  ) {
    const existing =
      await guild.channels
        .fetch(
          current.category_id
        )
        .catch(() => null);

    if (
      existing &&
      existing.type ===
        ChannelType.GuildCategory
    ) {
      return existing;
    }
  }

  return guild.channels.create({
    name: 'VOICE HDK',
    type: ChannelType.GuildCategory,
    reason:
      'Voice HDK Temp Voice'
  });
}

async function deleteOldCreatePanel(
  guild,
  generator,
  keepMessageId = null
) {
  if (
    !generator?.setup_channel_id ||
    !generator?.setup_message_id
  ) {
    return;
  }

  if (
    keepMessageId &&
    String(
      generator.setup_message_id
    ) ===
    String(keepMessageId)
  ) {
    return;
  }

  const oldChannel =
    await guild.channels
      .fetch(
        generator.setup_channel_id
      )
      .catch(() => null);

  if (
    !oldChannel ||
    !oldChannel.isTextBased()
  ) {
    return;
  }

  const oldMessage =
    await oldChannel.messages
      .fetch(
        generator.setup_message_id
      )
      .catch(() => null);

  if (
    oldMessage?.author?.id ===
    client.user.id
  ) {
    await oldMessage
      .delete()
      .catch(() => {});
  }
}

async function handleSetupConfirm(
  interaction
) {
  if (!interaction.guild) {
    return;
  }

  if (
    !interaction.memberPermissions?.has(
      PermissionsBitField.Flags.ManageGuild
    )
  ) {
    return tempReply(
      interaction,
      '⛔ Bạn không có quyền thiết lập.',
      {
        error: true
      }
    );
  }

  const session =
    getSetupSession(
      interaction.guild.id,
      interaction.user.id
    );

  if (!session) {
    return tempReply(
      interaction,
      '⌛ Phiên thiết lập đã hết hạn. Hãy dùng /setup lại.',
      {
        error: true
      }
    );
  }

  if (!session.channelId) {
    return tempReply(
      interaction,
      '📍 Hãy chọn kênh đặt nút Tạo phòng.',
      {
        error: true
      }
    );
  }

  if (!session.displayName) {
    return tempReply(
      interaction,
      '✏️ Hãy đặt tên hiển thị cho panel.',
      {
        error: true
      }
    );
  }

  await interaction.deferReply({
    ephemeral: true
  });

  const setupChannel =
    await interaction.guild.channels
      .fetch(
        session.channelId
      )
      .catch(() => null);

  if (
    !setupChannel ||
    !setupChannel.isTextBased()
  ) {
    return tempReply(
      interaction,
      '❌ Kênh thiết lập không còn tồn tại.',
      {
        error: true
      }
    );
  }

  const missing =
    getMissingPermissions(
      interaction.guild,
      setupChannel
    );

  const setupRequired = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.EmbedLinks,
    PermissionsBitField.Flags.ReadMessageHistory
  ];

  const setupMissing =
    setupRequired.filter(
      permission =>
        missing.includes(
          permission
        )
    );

  if (setupMissing.length) {
    return tempReply(
      interaction,
      '❌ Voice HDK thiếu quyền tại kênh đã chọn: ' +
      permissionNames(
        setupMissing
      ).join(', '),
      {
        error: true
      }
    );
  }

  const current =
    await getGenerator(
      interaction.guild.id
    );

  const category =
    await findOrCreateVoiceCategory(
      interaction.guild,
      current
    );

  let createMessage = null;

  if (
    current?.setup_channel_id &&
    current?.setup_message_id &&
    String(
      current.setup_channel_id
    ) ===
    String(setupChannel.id)
  ) {
    const existing =
      await setupChannel.messages
        .fetch(
          current.setup_message_id
        )
        .catch(() => null);

    if (
      existing?.author?.id ===
      client.user.id
    ) {
      createMessage =
        await existing.edit(
          buildCreateRoomPanel()
        );
    }
  }

  if (!createMessage) {
    createMessage =
      await setupChannel.send(
        buildCreateRoomPanel()
      );
  }

  await saveGenerator({
    guildId:
      interaction.guild.id,

    categoryId:
      category.id,

    generatorId:
      null,

    blogChannelId:
      current?.blog_channel_id ||
      null,

    trackedTextChannelId:
      current?.tracked_text_channel_id ||
      null,

    setupChannelId:
      setupChannel.id,

    setupMessageId:
      createMessage.id,

    displayName:
      session.displayName
  });

  if (
    current?.setup_message_id &&
    String(
      current.setup_message_id
    ) !==
    String(createMessage.id)
  ) {
    await deleteOldCreatePanel(
      interaction.guild,
      current,
      createMessage.id
    );
  }

  clearSetupSession(
    interaction.guild.id,
    interaction.user.id
  );

  await tempReply(
    interaction,
    `✅ Thiết lập hoàn tất tại <#${setupChannel.id}>.`
  );
}

async function createTempRoom(
  guild,
  member
) {
  const generator =
    await getGenerator(
      guild.id
    );

  if (
    !generator ||
    !generator.setup_channel_id
  ) {
    throw new Error(
      'Máy chủ chưa thiết lập Voice HDK.'
    );
  }

  const existingRecord =
    await getOwnedRoom(
      guild.id,
      member.id
    );

  if (existingRecord) {
    const existingChannel =
      await guild.channels
        .fetch(
          existingRecord.channel_id
        )
        .catch(() => null);

    if (
      existingChannel &&
      existingChannel.type ===
        ChannelType.GuildVoice
    ) {
      return {
        channel:
          existingChannel,

        created: false
      };
    }

    await deleteRoomRecord(
      existingRecord.channel_id
    );
  }

  let category = null;

  if (
    generator.category_id
  ) {
    category =
      await guild.channels
        .fetch(
          generator.category_id
        )
        .catch(() => null);
  }

  if (
    !category ||
    category.type !==
      ChannelType.GuildCategory
  ) {
    category =
      await guild.channels.create({
        name: 'VOICE HDK',
        type:
          ChannelType.GuildCategory,
        reason:
          'Voice HDK Temp Voice'
      });

    await pool.query(
      `
        UPDATE generators
        SET category_id=$1
        WHERE guild_id=$2
      `,
      [
        category.id,
        guild.id
      ]
    );
  }

  const roomName =
    cleanRoomName(
      member.displayName ||
      member.user.username
    );

  const channel =
    await guild.channels.create({
      name:
        `${ROOM_PREFIX}${roomName}`,

      type:
        ChannelType.GuildVoice,

      parent:
        category.id,

      userLimit: 0,

      reason:
        `Voice HDK - phòng của ${member.user.username}`,

      permissionOverwrites: [
        {
          id:
            guild.roles.everyone.id,

          allow: [
            PermissionsBitField
              .Flags
              .ViewChannel,

            PermissionsBitField
              .Flags
              .Connect
          ]
        },
        {
          id:
            member.id,

          allow: [
            PermissionsBitField
              .Flags
              .ViewChannel,

            PermissionsBitField
              .Flags
              .Connect,

            PermissionsBitField
              .Flags
              .Speak,

            PermissionsBitField
              .Flags
              .Stream,

            PermissionsBitField
              .Flags
              .UseVAD,

            PermissionsBitField
              .Flags
              .SendMessages,

            PermissionsBitField
              .Flags
              .ReadMessageHistory
          ]
        },
        {
          id:
            guild.members.me.id,

          allow: [
            PermissionsBitField
              .Flags
              .ViewChannel,

            PermissionsBitField
              .Flags
              .Connect,

            PermissionsBitField
              .Flags
              .SendMessages,

            PermissionsBitField
              .Flags
              .EmbedLinks,

            PermissionsBitField
              .Flags
              .ReadMessageHistory,

            PermissionsBitField
              .Flags
              .ManageChannels,

            PermissionsBitField
              .Flags
              .ManageRoles,

            PermissionsBitField
              .Flags
              .MoveMembers
          ]
        }
      ]
    });

  try {
    await saveRoom({
      guildId:
        guild.id,

      channelId:
        channel.id,

      ownerId:
        member.id,

      categoryId:
        category.id
    });

    await ensureBotRoomPermissions(
      channel
    );

    await grantOwnerPermissions(
      channel,
      member.id
    );

    await refreshRoomPanel(
      channel.id
    );

    return {
      channel,
      created: true
    };
  } catch (error) {
    await deleteRoomRecord(
      channel.id
    ).catch(() => {});

    await channel
      .delete(
        'Rollback vì tạo Temp Voice thất bại'
      )
      .catch(() => {});

    throw error;
  }
}

async function handleCreateRoomButton(
  interaction
) {
  if (!interaction.guild) {
    return;
  }

  if (
    !useCooldown(
      interaction.user.id,
      'create_room'
    )
  ) {
    return tempReply(
      interaction,
      '⏳ Thao tác quá nhanh.',
      {
        error: true
      }
    );
  }

  await interaction.deferReply({
    ephemeral: true
  });

  const member =
    await interaction.guild.members
      .fetch(
        interaction.user.id
      )
      .catch(() => null);

  if (!member) {
    return tempReply(
      interaction,
      '❌ Không tìm thấy bạn trong máy chủ.',
      {
        error: true
      }
    );
  }

  const result =
    await createTempRoom(
      interaction.guild,
      member
    );

  if (!result.created) {
    if (
      member.voice.channelId &&
      member.voice.channelId !==
        result.channel.id
    ) {
      await member.voice
        .setChannel(
          result.channel
        )
        .catch(() => {});
    }

    return tempReply(
      interaction,
      `🔊 Bạn đã có phòng: <#${result.channel.id}>`
    );
  }

  if (member.voice.channelId) {
    try {
      await member.voice.setChannel(
        result.channel
      );
    } catch (error) {
      logError(
        'MOVE_OWNER_NEW_ROOM',
        error,
        {
          guildId:
            interaction.guild.id,

          userId:
            member.id,

          channelId:
            result.channel.id
        }
      );
    }
  }

  await tempReply(
    interaction,
    `🔊 Phòng của bạn đã được tạo: <#${result.channel.id}>`
  );
}

async function deleteTempRoom(
  channel,
  reason =
    'Temp Voice không còn người'
) {
  if (!channel) {
    return;
  }

  const room =
    await getRoom(
      channel.id
    );

  if (!room) {
    return;
  }

  clearSelectedMember(
    channel.id
  );

  clearPendingTransfer(
    channel.id
  );

  await deleteRoomRecord(
    channel.id
  );

  await channel
    .delete(reason)
    .catch(error => {
      logError(
        'DELETE_TEMP_ROOM',
        error,
        {
          channelId:
            channel.id
        }
      );
    });
}

function scheduleEmptyRoomCheck(
  channelId
) {
  const timer = setTimeout(
    async () => {
      try {
        const channel =
          await client.channels
            .fetch(channelId)
            .catch(() => null);

        if (
          !channel ||
          channel.type !==
            ChannelType.GuildVoice
        ) {
          return;
        }

        const room =
          await getRoom(
            channel.id
          );

        if (!room) {
          return;
        }

        const humans =
          channel.members.filter(
            member =>
              !member.user.bot
          );

        if (
          humans.size === 0
        ) {
          await deleteTempRoom(
            channel,
            'Temp Voice trống'
          );
        }
      } catch (error) {
        logError(
          'EMPTY_ROOM_CHECK',
          error,
          {
            channelId
          }
        );
      }
    },
    2500
  );

  timer.unref?.();
}
async function getOwnerRoomContext(
  interaction
) {
  if (
    !interaction.guild ||
    !interaction.channelId
  ) {
    await tempReply(
      interaction,
      '❌ Không xác định được phòng.',
      {
        error: true
      }
    );

    return null;
  }

  const room =
    await getRoom(
      interaction.channelId
    );

  if (!room) {
    await tempReply(
      interaction,
      '❌ Đây không phải phòng Temp Voice.',
      {
        error: true
      }
    );

    return null;
  }

  const channel =
    await interaction.guild.channels
      .fetch(
        interaction.channelId
      )
      .catch(() => null);

  if (
    !channel ||
    channel.type !==
      ChannelType.GuildVoice
  ) {
    await tempReply(
      interaction,
      '❌ Phòng thoại không còn tồn tại.',
      {
        error: true
      }
    );

    return null;
  }

  if (
    String(room.owner_id) !==
    String(interaction.user.id)
  ) {
    await tempReply(
      interaction,
      '⛔ Chỉ chủ phòng mới dùng được chức năng này.',
      {
        error: true
      }
    );

    return null;
  }

  const member =
    await interaction.guild.members
      .fetch(
        interaction.user.id
      )
      .catch(() => null);

  if (
    !member ||
    member.voice.channelId !==
      channel.id
  ) {
    await tempReply(
      interaction,
      '❌ Bạn phải ở trong phòng của mình để điều khiển.',
      {
        error: true
      }
    );

    return null;
  }

  return {
    room,
    channel,
    member
  };
}

async function resolveSelectedMember(
  interaction,
  room,
  channel,
  {
    mustBeInRoom = false
  } = {}
) {
  const targetId =
    getSelectedMember(
      channel.id,
      room.owner_id
    );

  if (!targetId) {
    await tempReply(
      interaction,
      '👤 Hãy chọn thành viên trước.',
      {
        error: true
      }
    );

    return null;
  }

  if (
    String(targetId) ===
    String(room.owner_id)
  ) {
    clearSelectedMember(
      channel.id
    );

    await tempReply(
      interaction,
      '❌ Không thể chọn chính bạn.',
      {
        error: true
      }
    );

    return null;
  }

  if (
    String(targetId) ===
    String(client.user.id)
  ) {
    clearSelectedMember(
      channel.id
    );

    await tempReply(
      interaction,
      '❌ Không thể chọn Voice HDK.',
      {
        error: true
      }
    );

    return null;
  }

  const target =
    await interaction.guild.members
      .fetch(targetId)
      .catch(() => null);

  if (!target) {
    clearSelectedMember(
      channel.id
    );

    await tempReply(
      interaction,
      '❌ Thành viên không còn trong máy chủ.',
      {
        error: true
      }
    );

    return null;
  }

  if (
    target.user.bot
  ) {
    clearSelectedMember(
      channel.id
    );

    await tempReply(
      interaction,
      '❌ Không thể thực hiện thao tác này với bot.',
      {
        error: true
      }
    );

    return null;
  }

  if (
    mustBeInRoom &&
    target.voice.channelId !==
      channel.id
  ) {
    clearSelectedMember(
      channel.id
    );

    await tempReply(
      interaction,
      '❌ Thành viên không còn ở trong phòng.',
      {
        error: true
      }
    );

    return null;
  }

  return target;
}

async function handleMemberSelect(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  const targetId =
    interaction.values?.[0];

  if (
    !targetId ||
    !isSnowflake(targetId)
  ) {
    return tempReply(
      interaction,
      '❌ Thành viên đã chọn không hợp lệ.',
      {
        error: true
      }
    );
  }

  if (
    String(targetId) ===
    String(interaction.user.id)
  ) {
    clearSelectedMember(
      context.channel.id
    );

    return tempReply(
      interaction,
      '❌ Không cần chọn chính bạn.',
      {
        error: true
      }
    );
  }

  const target =
    await interaction.guild.members
      .fetch(targetId)
      .catch(() => null);

  if (!target) {
    clearSelectedMember(
      context.channel.id
    );

    return tempReply(
      interaction,
      '❌ Người này không phải thành viên của máy chủ.',
      {
        error: true
      }
    );
  }

  if (target.user.bot) {
    clearSelectedMember(
      context.channel.id
    );

    return tempReply(
      interaction,
      '❌ Không thể chọn bot.',
      {
        error: true
      }
    );
  }

  setSelectedMember(
    context.channel.id,
    context.room.owner_id,
    target.id
  );

  // Không gửi "Đã chọn thành viên".
  // Không refresh panel ở đây.
  // Chỉ xác nhận interaction để Discord không báo lỗi
  // và hạn chế tối đa việc màn hình chat bị nhảy.
  await interaction.deferUpdate();
}

function buildRenameModal(
  channel
) {
  const currentName =
    cleanRoomName(
      channel.name
    );

  const input =
    new TextInputBuilder()
      .setCustomId(
        'vc_rename_value'
      )
      .setLabel(
        'Tên phòng mới'
      )
      .setStyle(
        TextInputStyle.Short
      )
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(80)
      .setValue(
        currentName.slice(
          0,
          80
        )
      );

  return new ModalBuilder()
    .setCustomId(
      'vc_rename_modal'
    )
    .setTitle(
      'Đổi tên phòng'
    )
    .addComponents(
      new ActionRowBuilder()
        .addComponents(input)
    );
}

function buildLimitModal(
  channel
) {
  const input =
    new TextInputBuilder()
      .setCustomId(
        'vc_limit_value'
      )
      .setLabel(
        'Giới hạn thành viên'
      )
      .setPlaceholder(
        '0 = Không giới hạn'
      )
      .setStyle(
        TextInputStyle.Short
      )
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(2)
      .setValue(
        String(
          channel.userLimit || 0
        )
      );

  return new ModalBuilder()
    .setCustomId(
      'vc_limit_modal'
    )
    .setTitle(
      'Giới hạn phòng'
    )
    .addComponents(
      new ActionRowBuilder()
        .addComponents(input)
    );
}

function buildResetConfirmation() {
  const embed =
    new EmbedBuilder()
      .setColor(0xFEE75C)
      .setDescription(
        [
          '**♻️ Đặt lại phòng?**',
          '',
          'Phòng sẽ trở về:',
          '🔓 Mở',
          '👁 Công khai',
          '👥 Không giới hạn',
          '🌐 Khu vực tự động',
          '',
          'Quyền Mời/Cấm riêng của thành viên cũng sẽ được xóa.'
        ].join('\n')
      );

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'vc_reset_confirm'
          )
          .setLabel(
            'Đặt lại'
          )
          .setEmoji('♻️')
          .setStyle(
            ButtonStyle.Danger
          ),

        new ButtonBuilder()
          .setCustomId(
            'vc_reset_cancel'
          )
          .setLabel(
            'Hủy'
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  return {
    embeds: [embed],
    components: [row]
  };
}

async function handleLockButton(
  interaction,
  locked
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  if (
    !useCooldown(
      interaction.user.id,
      locked
        ? 'lock'
        : 'unlock'
    )
  ) {
    return tempReply(
      interaction,
      '⏳ Thao tác quá nhanh.',
      {
        error: true
      }
    );
  }

  await interaction.deferUpdate();

  const currentState =
    getRoomState(
      context.channel
    );

  if (
    currentState.locked !==
    locked
  ) {
    await setRoomLocked(
      context.channel,
      locked
    );
  }

  await refreshRoomPanelSafe(
    context.channel.id
  );

  await tempFollowUp(
    interaction,
    locked
      ? '🔒 Đã khóa phòng.'
      : '🔓 Đã mở phòng.'
  );
}

async function handleHideButton(
  interaction,
  hidden
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  if (
    !useCooldown(
      interaction.user.id,
      hidden
        ? 'hide'
        : 'show'
    )
  ) {
    return tempReply(
      interaction,
      '⏳ Thao tác quá nhanh.',
      {
        error: true
      }
    );
  }

  await interaction.deferUpdate();

  const currentState =
    getRoomState(
      context.channel
    );

  if (
    currentState.hidden !==
    hidden
  ) {
    await setRoomHidden(
      context.channel,
      hidden
    );
  }

  await refreshRoomPanelSafe(
    context.channel.id
  );

  await tempFollowUp(
    interaction,
    hidden
      ? '🙈 Đã ẩn phòng.'
      : '👁️ Đã hiện phòng.'
  );
}

async function handleRenameButton(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  await interaction.showModal(
    buildRenameModal(
      context.channel
    )
  );
}

async function handleRenameModal(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  await interaction.deferReply({
    ephemeral: true
  });

  const rawName =
    interaction.fields
      .getTextInputValue(
        'vc_rename_value'
      );

  const name =
    cleanRoomName(
      rawName
    );

  if (
    !name ||
    name === 'Phòng riêng'
  ) {
    return tempReply(
      interaction,
      '❌ Tên phòng không hợp lệ.',
      {
        error: true
      }
    );
  }

  const newName =
    `${ROOM_PREFIX}${name}`;

  if (
    context.channel.name !==
    newName
  ) {
    await context.channel.setName(
      newName,
      `Đổi tên bởi ${interaction.user.username}`
    );
  }

  await refreshRoomPanelSafe(
    context.channel.id
  );

  await tempReply(
    interaction,
    `✏️ Đã đổi tên phòng thành **${name}**.`
  );
}

async function handleLimitButton(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  await interaction.showModal(
    buildLimitModal(
      context.channel
    )
  );
}

async function handleLimitModal(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  await interaction.deferReply({
    ephemeral: true
  });

  const raw =
    interaction.fields
      .getTextInputValue(
        'vc_limit_value'
      )
      .trim();

  if (
    !/^\d{1,2}$/.test(raw)
  ) {
    return tempReply(
      interaction,
      '❌ Hãy nhập số từ 0 đến 99.',
      {
        error: true
      }
    );
  }

  const limit =
    Number(raw);

  if (
    !Number.isInteger(limit) ||
    limit < 0 ||
    limit > 99
  ) {
    return tempReply(
      interaction,
      '❌ Giới hạn phải từ 0 đến 99.',
      {
        error: true
      }
    );
  }

  await context.channel
    .setUserLimit(
      limit,
      `Thay đổi bởi ${interaction.user.username}`
    );

  await refreshRoomPanelSafe(
    context.channel.id
  );

  await tempReply(
    interaction,
    limit === 0
      ? '👥 Đã bỏ giới hạn thành viên.'
      : `👥 Giới hạn phòng: **${limit} người**.`
  );
}

async function handleInviteButton(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  if (
    !useCooldown(
      interaction.user.id,
      'invite'
    )
  ) {
    return tempReply(
      interaction,
      '⏳ Thao tác quá nhanh.',
      {
        error: true
      }
    );
  }

  const target =
    await resolveSelectedMember(
      interaction,
      context.room,
      context.channel
    );

  if (!target) {
    return;
  }

  await interaction.deferUpdate();

  await inviteMember(
    context.channel,
    target
  );

  clearSelectedMember(
    context.channel.id
  );

  await refreshRoomPanelSafe(
    context.channel.id
  );

  await tempFollowUp(
    interaction,
    `✉️ Đã mời **${safeMemberName(target)}** vào phòng.`
  );
}

async function handleDenyButton(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  if (
    !useCooldown(
      interaction.user.id,
      'deny'
    )
  ) {
    return tempReply(
      interaction,
      '⏳ Thao tác quá nhanh.',
      {
        error: true
      }
    );
  }

  const target =
    await resolveSelectedMember(
      interaction,
      context.room,
      context.channel
    );

  if (!target) {
    return;
  }

  await interaction.deferUpdate();

  await denyMember(
    context.channel,
    target
  );

  clearSelectedMember(
    context.channel.id
  );

  await refreshRoomPanelSafe(
    context.channel.id
  );

  await tempFollowUp(
    interaction,
    `⛔ Đã cấm **${safeMemberName(target)}** khỏi phòng.`
  );
}

async function handleKickButton(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  if (
    !useCooldown(
      interaction.user.id,
      'kick'
    )
  ) {
    return tempReply(
      interaction,
      '⏳ Thao tác quá nhanh.',
      {
        error: true
      }
    );
  }

  const target =
    await resolveSelectedMember(
      interaction,
      context.room,
      context.channel,
      {
        mustBeInRoom: true
      }
    );

  if (!target) {
    return;
  }

  await interaction.deferUpdate();

  await kickMember(
    context.channel,
    target
  );

  clearSelectedMember(
    context.channel.id
  );

  await refreshRoomPanelSafe(
    context.channel.id
  );

  await tempFollowUp(
    interaction,
    `👢 Đã đuổi **${safeMemberName(target)}** khỏi phòng.`
  );
}

async function handleResetButton(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  await interaction.reply({
    ...buildResetConfirmation(),
    ephemeral: true
  });
}

async function handleResetCancel(
  interaction
) {
  await interaction.update({
    content:
      '✖️ Đã hủy đặt lại phòng.',
    embeds: [],
    components: []
  });

  deleteReplyLater(
    interaction,
    SUCCESS_DELETE_MS
  );
}

async function handleResetConfirm(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  await interaction.deferUpdate();

  await resetRoom(
    context.channel,
    context.room.owner_id
  );

  await refreshRoomPanelSafe(
    context.channel.id
  );

  await interaction.editReply({
    content:
      '♻️ Phòng đã được đặt lại.',
    embeds: [],
    components: []
  });

  deleteReplyLater(
    interaction,
    SUCCESS_DELETE_MS
  );
}

async function handleRegionSelect(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  if (
    !useCooldown(
      interaction.user.id,
      'region'
    )
  ) {
    return tempReply(
      interaction,
      '⏳ Thao tác quá nhanh.',
      {
        error: true
      }
    );
  }

  const selected =
    interaction.values?.[0];

  if (!selected) {
    return tempReply(
      interaction,
      '❌ Khu vực không hợp lệ.',
      {
        error: true
      }
    );
  }

  await interaction.deferUpdate();

  if (
    selected === 'automatic'
  ) {
    await context.channel
      .setRTCRegion(null);

    const fresh =
      await interaction.guild.channels
        .fetch(
          context.channel.id
        );

    if (
      fresh.rtcRegion !== null
    ) {
      throw new Error(
        'Discord chưa xác nhận khu vực tự động.'
      );
    }

    await refreshRoomPanelSafe(
      context.channel.id
    );

    return tempFollowUp(
      interaction,
      '🌐 Khu vực: **Tự động**.'
    );
  }

  const regions =
    await getVoiceRegions(
      true
    );

  const region =
    regions.find(
      item =>
        item.id === selected
    );

  if (!region) {
    throw new Error(
      'Khu vực thoại không còn khả dụng.'
    );
  }

  await context.channel
    .setRTCRegion(
      region.id
    );

  const fresh =
    await interaction.guild.channels
      .fetch(
        context.channel.id
      );

  if (
    fresh.rtcRegion !==
    region.id
  ) {
    throw new Error(
      'Discord chưa xác nhận thay đổi khu vực.'
    );
  }

  await refreshRoomPanelSafe(
    context.channel.id
  );

  await tempFollowUp(
    interaction,
    `🌐 Khu vực: **${safeDisplayName(region.name || region.id, 40)}**.`
  );
}

async function transferRoomOwner(
  channel,
  oldOwnerId,
  newOwner
) {
  const room =
    await getRoom(
      channel.id
    );

  if (!room) {
    throw new Error(
      'Phòng không còn trong cơ sở dữ liệu.'
    );
  }

  if (
    String(room.owner_id) !==
    String(oldOwnerId)
  ) {
    throw new Error(
      'Chủ phòng đã thay đổi.'
    );
  }

  if (
    newOwner.voice.channelId !==
    channel.id
  ) {
    throw new Error(
      'Người nhận không còn ở trong phòng.'
    );
  }

  await grantOwnerPermissions(
    channel,
    newOwner.id
  );

  const updated =
    await updateRoomOwner(
      channel.id,
      oldOwnerId,
      newOwner.id
    );

  if (!updated) {
    await channel.permissionOverwrites
      .delete(newOwner.id)
      .catch(() => {});

    throw new Error(
      'Không thể cập nhật chủ phòng trong cơ sở dữ liệu.'
    );
  }

  try {
    await removeOwnerPermissions(
      channel,
      oldOwnerId
    );
  } catch (error) {
    logError(
      'TRANSFER_REMOVE_OLD_OWNER',
      error,
      {
        channelId:
          channel.id,

        oldOwnerId,
        newOwnerId:
          newOwner.id
      }
    );
  }

  clearSelectedMember(
    channel.id
  );

  await refreshRoomPanelSafe(
    channel.id
  );

  return updated;
}

async function expireTransferRequest(
  channelId,
  messageId
) {
  const key =
    String(channelId);

  const pending =
    pendingTransfers.get(key);

  if (
    !pending ||
    String(pending.messageId) !==
      String(messageId)
  ) {
    return;
  }

  pendingTransfers.delete(key);

  const guild =
    client.guilds.cache.get(
      pending.guildId
    );

  const channel =
    guild
      ? await guild.channels
          .fetch(channelId)
          .catch(() => null)
      : null;

  if (
    !channel ||
    !channel.isTextBased()
  ) {
    return;
  }

  const message =
    await channel.messages
      .fetch(messageId)
      .catch(() => null);

  if (!message) {
    return;
  }

  const target =
    await guild.members
      .fetch(
        pending.newOwnerId
      )
      .catch(() => null);

  const targetName =
    target
      ? safeMemberName(target)
      : 'Thành viên';

  try {
    await message.edit({
      content:
        `⌛ **${targetName}** đã từ chối do không phản hồi trong 60 giây.`,
      embeds: [],
      components: []
    });

    const timer =
      setTimeout(
        () => {
          message
            .delete()
            .catch(() => {});
        },
        SUCCESS_DELETE_MS
      );

    timer.unref?.();
  } catch (error) {
    logError(
      'TRANSFER_EXPIRE',
      error,
      {
        channelId,
        messageId
      }
    );
  }
}

async function handleTransferButton(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  if (
    !useCooldown(
      interaction.user.id,
      'transfer'
    )
  ) {
    return tempReply(
      interaction,
      '⏳ Thao tác quá nhanh.',
      {
        error: true
      }
    );
  }

  const target =
    await resolveSelectedMember(
      interaction,
      context.room,
      context.channel,
      {
        mustBeInRoom: true
      }
    );

  if (!target) {
    return;
  }

  await interaction.deferUpdate();

  clearPendingTransfer(
    context.channel.id
  );

  const expiresAt =
    Date.now() +
    TRANSFER_TIMEOUT_MS;

  const acceptButton =
    new ButtonBuilder()
      .setCustomId(
        `transfer_accept:${context.channel.id}`
      )
      .setLabel(
        'Đồng ý'
      )
      .setEmoji('👑')
      .setStyle(
        ButtonStyle.Success
      );

  const declineButton =
    new ButtonBuilder()
      .setCustomId(
        `transfer_decline:${context.channel.id}`
      )
      .setLabel(
        'Từ chối'
      )
      .setEmoji('✖️')
      .setStyle(
        ButtonStyle.Secondary
      );

  const row =
    new ActionRowBuilder()
      .addComponents(
        acceptButton,
        declineButton
      );

  const request =
    await context.channel.send({
      content: [
        `👑 <@${context.room.owner_id}> muốn chuyển quyền chủ phòng cho <@${target.id}>`,
        `⏳ Hết hạn ${relativeTimestamp(expiresAt)}`
      ].join('\n'),

      components: [row]
    });

  const pending = {
    guildId:
      interaction.guild.id,

    channelId:
      context.channel.id,

    oldOwnerId:
      context.room.owner_id,

    newOwnerId:
      target.id,

    messageId:
      request.id,

    expiresAt,

    timer: null
  };

  pending.timer =
    setTimeout(
      () => {
        expireTransferRequest(
          context.channel.id,
          request.id
        ).catch(
          error => {
            logError(
              'TRANSFER_TIMEOUT',
              error,
              {
                channelId:
                  context.channel.id,

                messageId:
                  request.id
              }
            );
          }
        );
      },
      TRANSFER_TIMEOUT_MS
    );

  pending.timer.unref?.();

  pendingTransfers.set(
    String(
      context.channel.id
    ),
    pending
  );

  // Chọn thành viên chỉ dùng cho một hành động.
  // Sau khi gửi yêu cầu chuyển chủ thì xóa lựa chọn.
  clearSelectedMember(
    context.channel.id
  );

  await refreshRoomPanelSafe(
    context.channel.id
  );
}

async function handleTransferResponse(
  interaction,
  action,
  channelId
) {
  const pending =
    pendingTransfers.get(
      String(channelId)
    );

  if (!pending) {
    return tempReply(
      interaction,
      '⌛ Yêu cầu chuyển chủ không còn hiệu lực.',
      {
        error: true
      }
    );
  }

  if (
    String(interaction.message.id) !==
    String(pending.messageId)
  ) {
    return tempReply(
      interaction,
      '⌛ Đây không còn là yêu cầu chuyển chủ hiện tại.',
      {
        error: true
      }
    );
  }

  if (
    String(interaction.user.id) !==
    String(pending.newOwnerId)
  ) {
    return tempReply(
      interaction,
      '⛔ Chỉ người được chọn mới có thể phản hồi.',
      {
        error: true
      }
    );
  }

  if (
    Date.now() >=
    pending.expiresAt
  ) {
    clearPendingTransfer(
      channelId
    );

    await interaction.update({
      content:
        '⌛ Yêu cầu chuyển chủ đã hết hạn do không phản hồi trong 60 giây.',
      components: []
    });

    const timer =
      setTimeout(
        () => {
          interaction.message
            .delete()
            .catch(() => {});
        },
        SUCCESS_DELETE_MS
      );

    timer.unref?.();

    return;
  }

  if (
    action === 'decline'
  ) {
    clearPendingTransfer(
      channelId
    );

    const target =
      await interaction.guild.members
        .fetch(
          interaction.user.id
        )
        .catch(() => null);

    await interaction.update({
      content:
        `✖️ **${target ? safeMemberName(target) : interaction.user.username}** đã từ chối nhận quyền chủ phòng.`,
      components: []
    });

    const timer =
      setTimeout(
        () => {
          interaction.message
            .delete()
            .catch(() => {});
        },
        SUCCESS_DELETE_MS
      );

    timer.unref?.();

    return;
  }

  const channel =
    await interaction.guild.channels
      .fetch(channelId)
      .catch(() => null);

  if (
    !channel ||
    channel.type !==
      ChannelType.GuildVoice
  ) {
    clearPendingTransfer(
      channelId
    );

    return tempReply(
      interaction,
      '❌ Phòng thoại không còn tồn tại.',
      {
        error: true
      }
    );
  }

  const currentRoom =
    await getRoom(
      channel.id
    );

  if (
    !currentRoom ||
    String(currentRoom.owner_id) !==
      String(pending.oldOwnerId)
  ) {
    clearPendingTransfer(
      channelId
    );

    return tempReply(
      interaction,
      '❌ Chủ phòng đã thay đổi. Yêu cầu này không còn hiệu lực.',
      {
        error: true
      }
    );
  }

  const newOwner =
    await interaction.guild.members
      .fetch(
        pending.newOwnerId
      )
      .catch(() => null);

  if (
    !newOwner ||
    newOwner.voice.channelId !==
      channel.id
  ) {
    clearPendingTransfer(
      channelId
    );

    await interaction.update({
      content:
        '❌ Không thể chuyển chủ vì người nhận không còn ở trong phòng.',
      components: []
    });

    const timer =
      setTimeout(
        () => {
          interaction.message
            .delete()
            .catch(() => {});
        },
        ERROR_DELETE_MS
      );

    timer.unref?.();

    return;
  }

  await interaction.deferUpdate();

  await transferRoomOwner(
    channel,
    pending.oldOwnerId,
    newOwner
  );

  clearPendingTransfer(
    channelId
  );

  await interaction.message.edit({
    content:
      `👑 **${safeMemberName(newOwner)}** đã trở thành chủ phòng.`,
    components: []
  });

  const timer =
    setTimeout(
      () => {
        interaction.message
          .delete()
          .catch(() => {});
      },
      SUCCESS_DELETE_MS
    );

  timer.unref?.();
}
function disableComponents(
  message
) {
  return (
    message.components?.map(
      row =>
        new ActionRowBuilder()
          .addComponents(
            row.components.map(
              component =>
                ButtonBuilder.from(
                  component
                ).setDisabled(true)
            )
          )
    ) || []
  );
}

async function getLogChannel(
  guild
) {
  const generator =
    await getGenerator(
      guild.id
    );

  if (
    !generator?.blog_channel_id
  ) {
    return null;
  }

  const channel =
    await guild.channels
      .fetch(
        generator.blog_channel_id
      )
      .catch(() => null);

  if (
    !channel ||
    !channel.isTextBased()
  ) {
    return null;
  }

  return channel;
}

function truncateText(
  value,
  maxLength = 1500
) {
  const text =
    String(value || '')
      .replace(/\r/g, '')
      .trim();

  if (
    text.length <=
    maxLength
  ) {
    return text;
  }

  return (
    text.slice(
      0,
      Math.max(
        1,
        maxLength - 1
      )
    ) + '…'
  );
}

function quoteLogText(
  value
) {
  const text =
    truncateText(
      value,
      1400
    )
      .replace(/\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  if (!text) {
    return '';
  }

  return `"${text.replace(
    /"/g,
    '”'
  )}"`;
}

function extractLinks(
  content
) {
  const matches =
    String(content || '')
      .match(
        /https?:\/\/[^\s<]+/gi
      ) || [];

  return [
    ...new Set(
      matches.map(
        link =>
          link.replace(
            /[),.;!?]+$/g,
            ''
          )
      )
    )
  ];
}

function attachmentNames(
  message
) {
  return [
    ...message.attachments.values()
  ].map(
    attachment =>
      safeDisplayName(
        attachment.name ||
        'tep-dinh-kem',
        80
      )
  );
}

function buildMessageLogText(
  message
) {
  const memberName =
    safeMemberName(
      message.member
    );

  const content =
    quoteLogText(
      message.content
    );

  const links =
    extractLinks(
      message.content
    );

  const files =
    attachmentNames(
      message
    );

  const time =
    vietnamTime(
      message.createdAt ||
      new Date()
    );

  if (
    !links.length &&
    !files.length
  ) {
    return (
      `${memberName} » ` +
      `${content || '"(không có nội dung)"'} ` +
      `• ${time}`
    );
  }

  const lines = [];

  if (content) {
    lines.push(
      `${memberName} » ${content}`
    );
  } else {
    lines.push(
      `${memberName} »`
    );
  }

  if (links.length) {
    lines.push(
      `🔗 Liên kết: ${
        links.join(' • ')
      }`
    );
  }

  if (files.length) {
    lines.push(
      `📎 Tệp đính kèm: ${
        files.join(' • ')
      }`
    );
  }

  lines.push(time);

  return lines.join('\n');
}

async function downloadAttachmentBuffer(
  attachment
) {
  if (!attachment?.url) {
    return null;
  }

  const maxBytes =
    20 * 1024 * 1024;

  if (
    Number(attachment.size || 0) >
    maxBytes
  ) {
    return null;
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      12_000
    );

  timeout.unref?.();

  try {
    const response =
      await fetch(
        attachment.url,
        {
          signal:
            controller.signal
        }
      );

    if (!response.ok) {
      return null;
    }

    const declaredLength =
      Number(
        response.headers.get(
          'content-length'
        ) || 0
      );

    if (
      declaredLength >
      maxBytes
    ) {
      return null;
    }

    const arrayBuffer =
      await response.arrayBuffer();

    if (
      arrayBuffer.byteLength >
      maxBytes
    ) {
      return null;
    }

    return Buffer.from(
      arrayBuffer
    );
  } catch {
    return null;
  } finally {
    clearTimeout(
      timeout
    );
  }
}

async function archiveAttachments(
  message
) {
  const files = [];
  const failed = [];

  for (
    const attachment
    of message.attachments.values()
  ) {
    const buffer =
      await downloadAttachmentBuffer(
        attachment
      );

    if (!buffer) {
      failed.push({
        name:
          attachment.name ||
          'tep-dinh-kem',

        url:
          attachment.url
      });

      continue;
    }

    files.push({
      attachment:
        buffer,

      name:
        attachment.name ||
        `attachment-${attachment.id}`
    });
  }

  return {
    files,
    failed
  };
}

async function sendMessageArchive(
  message
) {
  if (
    !message.guild ||
    message.author?.bot
  ) {
    return;
  }

  const generator =
    await getGenerator(
      message.guild.id
    );

  if (
    !generator?.tracked_text_channel_id ||
    String(
      generator.tracked_text_channel_id
    ) !==
    String(message.channelId)
  ) {
    return;
  }

  const logChannel =
    await getLogChannel(
      message.guild
    );

  if (
    !logChannel ||
    logChannel.id ===
      message.channelId
  ) {
    return;
  }

  const archive =
    await archiveAttachments(
      message
    );

  let content =
    buildMessageLogText(
      message
    );

  if (
    archive.failed.length
  ) {
    const fallback =
      archive.failed
        .map(
          item =>
            `⚠️ Không lưu được ${safeDisplayName(item.name, 60)}: ${item.url}`
        )
        .join('\n');

    content =
      `${content}\n${fallback}`;
  }

  await logChannel.send({
    content:
      truncateText(
        content,
        1900
      ),

    files:
      archive.files,

    allowedMentions: {
      parse: []
    }
  });
}

async function logMessageEdit(
  oldMessage,
  newMessage
) {
  if (
    !newMessage.guild ||
    newMessage.author?.bot
  ) {
    return;
  }

  const generator =
    await getGenerator(
      newMessage.guild.id
    );

  if (
    !generator?.tracked_text_channel_id ||
    String(
      generator.tracked_text_channel_id
    ) !==
    String(newMessage.channelId)
  ) {
    return;
  }

  const before =
    String(
      oldMessage?.content || ''
    ).trim();

  const after =
    String(
      newMessage?.content || ''
    ).trim();

  if (
    before === after
  ) {
    return;
  }

  const logChannel =
    await getLogChannel(
      newMessage.guild
    );

  if (!logChannel) {
    return;
  }

  const name =
    safeMemberName(
      newMessage.member
    );

  const beforeText =
    quoteLogText(before) ||
    '"(trống)"';

  const afterText =
    quoteLogText(after) ||
    '"(trống)"';

  const content = [
    `✏️ ${name} đã sửa tin nhắn`,
    `Trước: ${beforeText}`,
    `Sau: ${afterText}`,
    vietnamTime()
  ].join('\n');

  await logChannel.send({
    content:
      truncateText(
        content,
        1900
      ),

    allowedMentions: {
      parse: []
    }
  });
}

async function logMessageDelete(
  message
) {
  if (
    !message.guild ||
    message.author?.bot
  ) {
    return;
  }

  const generator =
    await getGenerator(
      message.guild.id
    );

  if (
    !generator?.tracked_text_channel_id ||
    String(
      generator.tracked_text_channel_id
    ) !==
    String(message.channelId)
  ) {
    return;
  }

  const logChannel =
    await getLogChannel(
      message.guild
    );

  if (!logChannel) {
    return;
  }

  const name =
    safeMemberName(
      message.member
    );

  const content =
    quoteLogText(
      message.content
    );

  const files =
    attachmentNames(
      message
    );

  const lines = [
    `🗑️ ${name} đã xóa tin nhắn`
  ];

  if (content) {
    lines.push(
      `Nội dung: ${content}`
    );
  }

  if (files.length) {
    lines.push(
      `📎 Tệp: ${files.join(' • ')}`
    );
  }

  if (
    !content &&
    !files.length
  ) {
    lines.push(
      'Nội dung không còn trong bộ nhớ của bot.'
    );
  }

  lines.push(
    vietnamTime()
  );

  await logChannel.send({
    content:
      truncateText(
        lines.join('\n'),
        1900
      ),

    allowedMentions: {
      parse: []
    }
  });
}

async function sendActionLog(
  guild,
  text
) {
  const logChannel =
    await getLogChannel(
      guild
    );

  if (!logChannel) {
    return;
  }

  await logChannel.send({
    content:
      `${truncateText(
        text,
        1750
      )} • ${vietnamTime()}`,

    allowedMentions: {
      parse: []
    }
  });
}

async function handleVoiceStateUpdate(
  oldState,
  newState
) {
  const guild =
    newState.guild ||
    oldState.guild;

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
      await refreshRoomPanelSafe(
        oldChannelId
      );

      scheduleEmptyRoomCheck(
        oldChannelId
      );
    }
  }

  if (newChannelId) {
    const newRoom =
      await getRoom(
        newChannelId
      );

    if (newRoom) {
      await refreshRoomPanelSafe(
        newChannelId
      );
    }
  }

  if (
    oldChannelId &&
    newChannelId
  ) {
    await sendActionLog(
      guild,
      `🔊 ${safeMemberName(newState.member)} chuyển phòng thoại`
    ).catch(
      error => {
        logError(
          'VOICE_MOVE_LOG',
          error,
          {
            guildId:
              guild.id,

            userId:
              newState.id
          }
        );
      }
    );
  }
}

async function reconcileRooms() {
  const result =
    await pool.query(`
      SELECT *
      FROM rooms
      ORDER BY created_at ASC
    `);

  for (
    const room
    of result.rows
  ) {
    try {
      const guild =
        client.guilds.cache.get(
          String(room.guild_id)
        );

      if (!guild) {
        await deleteRoomRecord(
          room.channel_id
        );

        continue;
      }

      const channel =
        await guild.channels
          .fetch(
            room.channel_id
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

      const owner =
        await guild.members
          .fetch(
            room.owner_id
          )
          .catch(() => null);

      if (!owner) {
        const humans =
          channel.members.filter(
            member =>
              !member.user.bot
          );

        if (
          humans.size === 0
        ) {
          await deleteTempRoom(
            channel,
            'Chủ phòng không còn trong máy chủ'
          );

          continue;
        }

        const replacement =
          humans.first();

        await updateRoomOwner(
          channel.id,
          room.owner_id,
          replacement.id
        );

        await grantOwnerPermissions(
          channel,
          replacement.id
        );

        await removeOwnerPermissions(
          channel,
          room.owner_id
        );
      }

      await ensureBotRoomPermissions(
        channel
      );

      await refreshRoomPanelSafe(
        channel.id
      );

      const humans =
        channel.members.filter(
          member =>
            !member.user.bot
        );

      if (
        humans.size === 0
      ) {
        scheduleEmptyRoomCheck(
          channel.id
        );
      }
    } catch (error) {
      logError(
        'RECONCILE_ROOM',
        error,
        {
          channelId:
            room.channel_id,

          guildId:
            room.guild_id
        }
      );
    }
  }
}

async function handlePanelCommand(
  interaction
) {
  if (!interaction.guild) {
    return tempReply(
      interaction,
      '❌ Lệnh này chỉ dùng trong máy chủ.',
      {
        error: true
      }
    );
  }

  await interaction.deferReply({
    ephemeral: true
  });

  let channelId =
    interaction.channelId;

  let room =
    await getRoom(
      channelId
    );

  if (!room) {
    room =
      await getOwnedRoom(
        interaction.guild.id,
        interaction.user.id
      );

    if (room) {
      channelId =
        room.channel_id;
    }
  }

  if (!room) {
    return tempReply(
      interaction,
      '❌ Không tìm thấy phòng Temp Voice của bạn.',
      {
        error: true
      }
    );
  }

  const isOwner =
    String(room.owner_id) ===
    String(interaction.user.id);

  const canManage =
    interaction.memberPermissions?.has(
      PermissionsBitField.Flags.ManageGuild
    );

  if (
    !isOwner &&
    !canManage
  ) {
    return tempReply(
      interaction,
      '⛔ Bạn không có quyền dựng lại panel của phòng này.',
      {
        error: true
      }
    );
  }

  const panel =
    await refreshRoomPanel(
      channelId
    );

  if (!panel) {
    return tempReply(
      interaction,
      '❌ Không thể dựng lại panel.',
      {
        error: true
      }
    );
  }

  await tempReply(
    interaction,
    '✅ Panel đã được kiểm tra và khôi phục.'
  );
}

async function handleDoctorCommand(
  interaction
) {
  if (!interaction.guild) {
    return tempReply(
      interaction,
      '❌ Lệnh này chỉ dùng trong máy chủ.',
      {
        error: true
      }
    );
  }

  if (
    !interaction.memberPermissions?.has(
      PermissionsBitField.Flags.ManageGuild
    )
  ) {
    return tempReply(
      interaction,
      '⛔ Bạn cần quyền Quản lý máy chủ.',
      {
        error: true
      }
    );
  }

  await interaction.deferReply({
    ephemeral: true
  });

  const checks = [];

  try {
    await pool.query(
      'SELECT 1'
    );

    checks.push(
      '✅ PostgreSQL'
    );
  } catch {
    checks.push(
      '❌ PostgreSQL'
    );
  }

  checks.push(
    client.isReady()
      ? '✅ Discord Gateway'
      : '❌ Discord Gateway'
  );

  const generator =
    await getGenerator(
      interaction.guild.id
    ).catch(() => null);

  if (generator) {
    checks.push(
      '✅ Cấu hình máy chủ'
    );
  } else {
    checks.push(
      '❌ Chưa /setup'
    );
  }

  const missing =
    getMissingPermissions(
      interaction.guild
    );

  if (!missing.length) {
    checks.push(
      '✅ Quyền bot'
    );
  } else {
    checks.push(
      `❌ Thiếu quyền: ${permissionNames(
        missing
      ).join(', ')}`
    );
  }

  if (
    generator?.setup_channel_id
  ) {
    const setupChannel =
      await interaction.guild.channels
        .fetch(
          generator.setup_channel_id
        )
        .catch(() => null);

    if (
      setupChannel &&
      setupChannel.isTextBased()
    ) {
      checks.push(
        '✅ Kênh Tạo phòng'
      );
    } else {
      checks.push(
        '❌ Kênh Tạo phòng'
      );
    }
  }

  try {
    const regions =
      await getVoiceRegions(
        true
      );

    checks.push(
      regions.length
        ? `✅ Voice Regions (${regions.length})`
        : '⚠️ Voice Regions trống'
    );
  } catch {
    checks.push(
      '❌ Voice Regions'
    );
  }

  await interaction.editReply({
    content: [
      '**🩺 Voice HDK Doctor**',
      '',
      ...checks
    ].join('\n')
  });
}

async function showLogSetupModal(
  interaction
) {
  const modal =
    new ModalBuilder()
      .setCustomId(
        'log_setup_modal'
      )
      .setTitle(
        'Thiết lập nhật ký'
      );

  const trackedInput =
    new TextInputBuilder()
      .setCustomId(
        'log_tracked_channel'
      )
      .setLabel(
        'ID kênh cần theo dõi'
      )
      .setPlaceholder(
        'Ví dụ: 123456789012345678'
      )
      .setStyle(
        TextInputStyle.Short
      )
      .setRequired(true);

  const logInput =
    new TextInputBuilder()
      .setCustomId(
        'log_output_channel'
      )
      .setLabel(
        'ID kênh nhận nhật ký'
      )
      .setPlaceholder(
        'Ví dụ: 123456789012345678'
      )
      .setStyle(
        TextInputStyle.Short
      )
      .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder()
      .addComponents(
        trackedInput
      ),

    new ActionRowBuilder()
      .addComponents(
        logInput
      )
  );

  await interaction.showModal(
    modal
  );
}

async function handleLogSetupModal(
  interaction
) {
  if (!interaction.guild) {
    return;
  }

  if (
    !interaction.memberPermissions?.has(
      PermissionsBitField.Flags.ManageGuild
    )
  ) {
    return tempReply(
      interaction,
      '⛔ Bạn cần quyền Quản lý máy chủ.',
      {
        error: true
      }
    );
  }

  await interaction.deferReply({
    ephemeral: true
  });

  const trackedId =
    interaction.fields
      .getTextInputValue(
        'log_tracked_channel'
      )
      .trim();

  const logId =
    interaction.fields
      .getTextInputValue(
        'log_output_channel'
      )
      .trim();

  if (
    !isSnowflake(trackedId) ||
    !isSnowflake(logId)
  ) {
    return tempReply(
      interaction,
      '❌ ID kênh không hợp lệ.',
      {
        error: true
      }
    );
  }

  if (
    trackedId === logId
  ) {
    return tempReply(
      interaction,
      '❌ Kênh theo dõi và kênh nhật ký phải khác nhau.',
      {
        error: true
      }
    );
  }

  const trackedChannel =
    await interaction.guild.channels
      .fetch(trackedId)
      .catch(() => null);

  const logChannel =
    await interaction.guild.channels
      .fetch(logId)
      .catch(() => null);

  if (
    !trackedChannel ||
    !trackedChannel.isTextBased() ||
    !logChannel ||
    !logChannel.isTextBased()
  ) {
    return tempReply(
      interaction,
      '❌ Một trong hai kênh không phải kênh văn bản hợp lệ.',
      {
        error: true
      }
    );
  }

  const generator =
    await getGenerator(
      interaction.guild.id
    );

  if (!generator) {
    return tempReply(
      interaction,
      '❌ Hãy chạy /setup trước.',
      {
        error: true
      }
    );
  }

  const me =
    interaction.guild.members.me ||
    await interaction.guild.members
      .fetchMe();

  const trackedPerms =
    trackedChannel.permissionsFor(
      me
    );

  const logPerms =
    logChannel.permissionsFor(
      me
    );

  if (
    !trackedPerms?.has(
      PermissionsBitField.Flags.ViewChannel
    ) ||
    !trackedPerms?.has(
      PermissionsBitField.Flags.ReadMessageHistory
    )
  ) {
    return tempReply(
      interaction,
      '❌ Bot thiếu quyền xem/đọc lịch sử tại kênh cần theo dõi.',
      {
        error: true
      }
    );
  }

  if (
    !logPerms?.has(
      PermissionsBitField.Flags.ViewChannel
    ) ||
    !logPerms?.has(
      PermissionsBitField.Flags.SendMessages
    )
  ) {
    return tempReply(
      interaction,
      '❌ Bot thiếu quyền xem/gửi tin nhắn tại kênh nhật ký.',
      {
        error: true
      }
    );
  }

  await pool.query(
    `
      UPDATE generators
      SET
        tracked_text_channel_id=$1,
        blog_channel_id=$2
      WHERE guild_id=$3
    `,
    [
      trackedChannel.id,
      logChannel.id,
      interaction.guild.id
    ]
  );

  await tempReply(
    interaction,
    `✅ Theo dõi <#${trackedChannel.id}> → nhật ký <#${logChannel.id}>.`
  );
}
async function handleLogSetupCommand(
  interaction
) {
  if (!interaction.guild) {
    return tempReply(
      interaction,
      '❌ Lệnh này chỉ dùng trong máy chủ.',
      {
        error: true
      }
    );
  }

  if (
    !interaction.memberPermissions?.has(
      PermissionsBitField.Flags.ManageGuild
    )
  ) {
    return tempReply(
      interaction,
      '⛔ Bạn cần quyền Quản lý máy chủ.',
      {
        error: true
      }
    );
  }

  await showLogSetupModal(
    interaction
  );
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('setup')
      .setDescription(
        'Thiết lập Voice HDK'
      )
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('panel')
      .setDescription(
        'Kiểm tra và khôi phục panel phòng'
      )
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('doctor')
      .setDescription(
        'Kiểm tra trạng thái Voice HDK'
      )
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('logsetup')
      .setDescription(
        'Thiết lập kênh theo dõi và nhật ký'
      )
      .setDMPermission(false)
  ].map(
    command =>
      command.toJSON()
  );

  await client.application.commands.set(
    commands
  );
}

async function handleInteraction(
  interaction
) {
  if (interaction.isChatInputCommand()) {
    switch (
      interaction.commandName
    ) {
      case 'setup':
        return handleSetupCommand(
          interaction
        );

      case 'panel':
        return handlePanelCommand(
          interaction
        );

      case 'doctor':
        return handleDoctorCommand(
          interaction
        );

      case 'logsetup':
        return handleLogSetupCommand(
          interaction
        );

      default:
        return;
    }
  }

  if (
    interaction.isChannelSelectMenu() &&
    interaction.customId ===
      'setup_channel'
  ) {
    return handleSetupChannelSelect(
      interaction
    );
  }

  if (
    interaction.isUserSelectMenu() &&
    interaction.customId ===
      'vc_member_select'
  ) {
    return handleMemberSelect(
      interaction
    );
  }

  if (
    interaction.isStringSelectMenu() &&
    interaction.customId ===
      'vc_region'
  ) {
    return handleRegionSelect(
      interaction
    );
  }

  if (interaction.isModalSubmit()) {
    switch (
      interaction.customId
    ) {
      case 'setup_name_modal':
        return handleSetupNameModal(
          interaction
        );

      case 'vc_rename_modal':
        return handleRenameModal(
          interaction
        );

      case 'vc_limit_modal':
        return handleLimitModal(
          interaction
        );

      case 'log_setup_modal':
        return handleLogSetupModal(
          interaction
        );

      default:
        return;
    }
  }

  if (!interaction.isButton()) {
    return;
  }

  if (
    interaction.customId.startsWith(
      'transfer_accept:'
    )
  ) {
    const channelId =
      interaction.customId.slice(
        'transfer_accept:'.length
      );

    if (!isSnowflake(channelId)) {
      return tempReply(
        interaction,
        '❌ Yêu cầu chuyển chủ không hợp lệ.',
        {
          error: true
        }
      );
    }

    return handleTransferResponse(
      interaction,
      'accept',
      channelId
    );
  }

  if (
    interaction.customId.startsWith(
      'transfer_decline:'
    )
  ) {
    const channelId =
      interaction.customId.slice(
        'transfer_decline:'.length
      );

    if (!isSnowflake(channelId)) {
      return tempReply(
        interaction,
        '❌ Yêu cầu chuyển chủ không hợp lệ.',
        {
          error: true
        }
      );
    }

    return handleTransferResponse(
      interaction,
      'decline',
      channelId
    );
  }

  switch (
    interaction.customId
  ) {
    case 'setup_name':
      return showSetupNameModal(
        interaction
      );

    case 'setup_confirm':
      return handleSetupConfirm(
        interaction
      );

    case 'voice_create':
      return handleCreateRoomButton(
        interaction
      );

    case 'vc_lock':
      return handleLockButton(
        interaction,
        true
      );

    case 'vc_unlock':
      return handleLockButton(
        interaction,
        false
      );

    case 'vc_hide':
      return handleHideButton(
        interaction,
        true
      );

    case 'vc_show':
      return handleHideButton(
        interaction,
        false
      );

    case 'vc_rename':
      return handleRenameButton(
        interaction
      );

    case 'vc_limit':
      return handleLimitButton(
        interaction
      );

    case 'vc_invite':
      return handleInviteButton(
        interaction
      );

    case 'vc_transfer':
      return handleTransferButton(
        interaction
      );

    case 'vc_deny':
      return handleDenyButton(
        interaction
      );

    case 'vc_kick':
      return handleKickButton(
        interaction
      );

    case 'vc_reset':
      return handleResetButton(
        interaction
      );

    case 'vc_reset_confirm':
      return handleResetConfirm(
        interaction
      );

    case 'vc_reset_cancel':
      return handleResetCancel(
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
        error,
        {
          interactionId:
            interaction.id,

          guildId:
            interaction.guildId,

          channelId:
            interaction.channelId,

          userId:
            interaction.user?.id,

          customId:
            interaction.customId,

          commandName:
            interaction.commandName
        }
      );

      const message =
        error?.message &&
        String(error.message)
          .length <= 150
          ? `❌ ${error.message}`
          : '❌ Đã xảy ra lỗi khi xử lý thao tác.';

      try {
        await tempReply(
          interaction,
          message,
          {
            error: true
          }
        );
      } catch {}
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
      await handleVoiceStateUpdate(
        oldState,
        newState
      );
    } catch (error) {
      logError(
        'VOICE_STATE_UPDATE',
        error,
        {
          guildId:
            newState.guild?.id ||
            oldState.guild?.id,

          userId:
            newState.id ||
            oldState.id,

          oldChannelId:
            oldState.channelId,

          newChannelId:
            newState.channelId
        }
      );
    }
  }
);

client.on(
  Events.MessageCreate,
  async message => {
    try {
      await sendMessageArchive(
        message
      );
    } catch (error) {
      logError(
        'MESSAGE_CREATE_LOG',
        error,
        {
          guildId:
            message.guildId,

          channelId:
            message.channelId,

          messageId:
            message.id
        }
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
      if (newMessage.partial) {
        await newMessage
          .fetch()
          .catch(() => {});
      }

      await logMessageEdit(
        oldMessage,
        newMessage
      );
    } catch (error) {
      logError(
        'MESSAGE_UPDATE_LOG',
        error,
        {
          guildId:
            newMessage.guildId,

          channelId:
            newMessage.channelId,

          messageId:
            newMessage.id
        }
      );
    }
  }
);

client.on(
  Events.MessageDelete,
  async message => {
    try {
      await logMessageDelete(
        message
      );
    } catch (error) {
      logError(
        'MESSAGE_DELETE_LOG',
        error,
        {
          guildId:
            message.guildId,

          channelId:
            message.channelId,

          messageId:
            message.id
        }
      );
    }
  }
);

client.on(
  Events.ChannelDelete,
  async channel => {
    try {
      if (
        channel.type ===
        ChannelType.GuildVoice
      ) {
        const room =
          await getRoom(
            channel.id
          );

        if (room) {
          await deleteRoomRecord(
            channel.id
          );
        }
      }

      const generator =
        await getGenerator(
          channel.guild.id
        );

      if (!generator) {
        return;
      }

      const updates = [];
      const values = [];
      let index = 1;

      if (
        String(
          generator.setup_channel_id ||
          ''
        ) ===
        String(channel.id)
      ) {
        updates.push(
          `setup_channel_id=$${index++}`
        );

        values.push(null);

        updates.push(
          `setup_message_id=$${index++}`
        );

        values.push(null);
      }

      if (
        String(
          generator.blog_channel_id ||
          ''
        ) ===
        String(channel.id)
      ) {
        updates.push(
          `blog_channel_id=$${index++}`
        );

        values.push(null);
      }

      if (
        String(
          generator.tracked_text_channel_id ||
          ''
        ) ===
        String(channel.id)
      ) {
        updates.push(
          `tracked_text_channel_id=$${index++}`
        );

        values.push(null);
      }

      if (
        String(
          generator.category_id ||
          ''
        ) ===
        String(channel.id)
      ) {
        updates.push(
          `category_id=$${index++}`
        );

        values.push(null);
      }

      if (!updates.length) {
        return;
      }

      values.push(
        channel.guild.id
      );

      await pool.query(
        `
          UPDATE generators
          SET ${updates.join(', ')}
          WHERE guild_id=$${index}
        `,
        values
      );
    } catch (error) {
      logError(
        'CHANNEL_DELETE',
        error,
        {
          guildId:
            channel.guild?.id,

          channelId:
            channel.id
        }
      );
    }
  }
);

client.on(
  Events.GuildDelete,
  async guild => {
    try {
      await pool.query(
        `
          DELETE FROM rooms
          WHERE guild_id=$1
        `,
        [guild.id]
      );

      await pool.query(
        `
          DELETE FROM generators
          WHERE guild_id=$1
        `,
        [guild.id]
      );
    } catch (error) {
      logError(
        'GUILD_DELETE',
        error,
        {
          guildId:
            guild.id
        }
      );
    }
  }
);

client.once(
  Events.ClientReady,
  async readyClient => {
    console.log(
      `[DISCORD] ${readyClient.user.tag} đã online.`
    );

    try {
      await registerCommands();

      console.log(
        '[COMMANDS] Slash commands đã sẵn sàng.'
      );
    } catch (error) {
      logError(
        'REGISTER_COMMANDS',
        error
      );
    }

    try {
      await reconcileRooms();

      console.log(
        '[ROOMS] Đã đồng bộ Temp Voice.'
      );
    } catch (error) {
      logError(
        'RECONCILE_ROOMS',
        error
      );
    }
  }
);

async function startBot() {
  try {
    await initDatabase();
  } catch (error) {
    logError(
      'DATABASE_STARTUP',
      error
    );

    try {
      healthServer.close();
    } catch {}

    process.exit(1);
    return;
  }

  try {
    await client.login(
      TOKEN
    );
  } catch (error) {
    logError(
      'DISCORD_LOGIN',
      error
    );

    try {
      await pool.end();
    } catch {}

    try {
      healthServer.close();
    } catch {}

    process.exit(1);
  }
}

async function shutdown(
  signal
) {
  console.log(
    `[SYSTEM] Nhận ${signal}, đang tắt...`
  );

  for (
    const pending
    of pendingTransfers.values()
  ) {
    if (pending.timer) {
      clearTimeout(
        pending.timer
      );
    }
  }

  pendingTransfers.clear();
  selectedMembers.clear();
  setupSessions.clear();
  cooldowns.clear();
  panelLocks.clear();

  try {
    client.destroy();
  } catch {}

  try {
    await pool.end();
  } catch {}

  try {
    healthServer.close();
  } catch {}

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

startBot();

// UPTIMEROBOT / RENDER FREE
// URL: https://TEN-SERVICE-CUA-BAN.onrender.com/health
// Method: GET
