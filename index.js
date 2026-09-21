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
  PermissionOverwriteType,
  SlashCommandBuilder
} = require('discord.js');

const { Pool } = require('pg');
const http = require('http');

const BOT_NAME = 'Voice HDK';
const BOT_VERSION = '5.0.0';

const TOKEN = (
  process.env.DISCORD_TOKEN ||
  process.env.TOKEN ||
  ''
).trim();

const DATABASE_URL = (
  process.env.DATABASE_URL ||
  ''
).trim();

const PORT = Number(
  process.env.PORT || 8080
);

const ROOM_PREFIX = '🔊・';
const CREATE_CHANNEL_NAME = '🔊・tạo-phòng';
const CHAT_LOG_CHANNEL_NAME = '💬・nhật-ký-chat';
const ACTION_LOG_CHANNEL_NAME = '⚙️・nhật-ký-chức-năng';

const SUCCESS_DELETE_MS = 3000;
const ERROR_DELETE_MS = 4000;
const ACTION_COOLDOWN_MS = 1500;
const TRANSFER_TIMEOUT_MS = 60000;
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

if (!TOKEN) {
  throw new Error(
    'Thiếu DISCORD_TOKEN trong biến môi trường.'
  );
}

if (!DATABASE_URL) {
  throw new Error(
    'Thiếu DATABASE_URL trong biến môi trường.'
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
const createLocks = new Map();
const cooldowns = new Map();
const selectedMembers = new Map();
const pendingTransfers = new Map();
const setupSessions = new Map();

let regionCache = {
  expiresAt: 0,
  regions: []
};

const REQUIRED_PERMISSIONS = [
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
    'Kết nối Voice'
  ]
]);

function logError(
  scope,
  error
) {
  const message =
    error?.stack ||
    error?.message ||
    String(error);

  console.error(
    `[${BOT_NAME}] [${scope}]`,
    message
  );
}

pool.on(
  'error',
  error => {
    logError(
      'POSTGRES',
      error
    );
  }
);

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
      `[${BOT_NAME}] [DISCORD_WARN]`,
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

    process.exit(1);
  }
);

const healthServer = http.createServer(
  (req, res) => {
    if (
      req.url !== '/' &&
      req.url !== '/health'
    ) {
      res.writeHead(
        404,
        {
          'Content-Type':
            'text/plain; charset=utf-8'
        }
      );

      res.end(
        'Not Found'
      );

      return;
    }

    res.writeHead(
      200,
      {
        'Content-Type':
          'application/json; charset=utf-8',
        'Cache-Control':
          'no-store'
      }
    );

    res.end(
      JSON.stringify({
        ok: true,
        service: BOT_NAME,
        version: BOT_VERSION
      })
    );
  }
);

async function initDatabase() {
  await pool.query(
    'SELECT 1'
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS generators (
      guild_id BIGINT PRIMARY KEY
    )
  `);

  await pool.query(`
    ALTER TABLE generators
    ADD COLUMN IF NOT EXISTS display_name TEXT
  `);

  await pool.query(`
    ALTER TABLE generators
    ADD COLUMN IF NOT EXISTS button_category_id BIGINT
  `);

  await pool.query(`
    ALTER TABLE generators
    ADD COLUMN IF NOT EXISTS blog_category_id BIGINT
  `);

  await pool.query(`
    ALTER TABLE generators
    ADD COLUMN IF NOT EXISTS create_channel_id BIGINT
  `);

  await pool.query(`
    ALTER TABLE generators
    ADD COLUMN IF NOT EXISTS create_message_id BIGINT
  `);

  await pool.query(`
    ALTER TABLE generators
    ADD COLUMN IF NOT EXISTS chat_log_channel_id BIGINT
  `);

  await pool.query(`
    ALTER TABLE generators
    ADD COLUMN IF NOT EXISTS action_log_channel_id BIGINT
  `);

  await pool.query(`
    ALTER TABLE generators
    ADD COLUMN IF NOT EXISTS tracked_text_channel_id BIGINT
  `);

  await pool.query(`
    ALTER TABLE generators
    ADD COLUMN IF NOT EXISTS installed_at TIMESTAMPTZ
  `);

  await pool.query(`
    ALTER TABLE generators
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
  `);

  await pool.query(`
    ALTER TABLE generators
    ALTER COLUMN category_id DROP NOT NULL
  `).catch(
    () => {}
  );

  await pool.query(`
    ALTER TABLE generators
    ALTER COLUMN generator_id DROP NOT NULL
  `).catch(
    () => {}
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      guild_id BIGINT NOT NULL,
      channel_id BIGINT PRIMARY KEY,
      owner_id BIGINT NOT NULL,
      category_id BIGINT,
      control_message_id BIGINT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE rooms
    ADD COLUMN IF NOT EXISTS control_message_id BIGINT
  `);

  await pool.query(`
    ALTER TABLE rooms
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
  `);

  await pool.query(`
    DELETE FROM rooms a
    USING rooms b
    WHERE
      a.guild_id = b.guild_id
      AND a.owner_id = b.owner_id
      AND a.channel_id < b.channel_id
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    rooms_one_owner_per_guild
    ON rooms(guild_id, owner_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    rooms_guild_idx
    ON rooms(guild_id)
  `);

  console.log(
    `[${BOT_NAME}] PostgreSQL sẵn sàng.`
  );
}

async function getGenerator(
  guildId
) {
  const result =
    await pool.query(
      `
        SELECT *
        FROM generators
        WHERE guild_id = $1
        LIMIT 1
      `,
      [
        guildId
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}

async function saveGenerator({
  guildId,
  displayName,
  buttonCategoryId,
  blogCategoryId,
  createChannelId,
  createMessageId,
  chatLogChannelId,
  actionLogChannelId
}) {
  const result =
    await pool.query(
      `
        INSERT INTO generators (
          guild_id,
          display_name,
          button_category_id,
          blog_category_id,
          create_channel_id,
          create_message_id,
          chat_log_channel_id,
          action_log_channel_id,
          installed_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          NOW(),
          NOW()
        )
        ON CONFLICT (guild_id)
        DO UPDATE SET
          display_name =
            EXCLUDED.display_name,
          button_category_id =
            EXCLUDED.button_category_id,
          blog_category_id =
            EXCLUDED.blog_category_id,
          create_channel_id =
            EXCLUDED.create_channel_id,
          create_message_id =
            EXCLUDED.create_message_id,
          chat_log_channel_id =
            EXCLUDED.chat_log_channel_id,
          action_log_channel_id =
            EXCLUDED.action_log_channel_id,
          updated_at =
            NOW()
        RETURNING *
      `,
      [
        guildId,
        displayName,
        buttonCategoryId,
        blogCategoryId,
        createChannelId,
        createMessageId,
        chatLogChannelId,
        actionLogChannelId
      ]
    );

  return result.rows[0];
}

async function deleteGenerator(
  guildId
) {
  await pool.query(
    `
      DELETE FROM generators
      WHERE guild_id = $1
    `,
    [
      guildId
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
      SET
        tracked_text_channel_id = $1,
        updated_at = NOW()
      WHERE guild_id = $2
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
  const result =
    await pool.query(
      `
        SELECT *
        FROM rooms
        WHERE channel_id = $1
        LIMIT 1
      `,
      [
        channelId
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}

async function getOwnedRoom(
  guildId,
  ownerId
) {
  const result =
    await pool.query(
      `
        SELECT *
        FROM rooms
        WHERE
          guild_id = $1
          AND owner_id = $2
        LIMIT 1
      `,
      [
        guildId,
        ownerId
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}

async function getGuildRooms(
  guildId
) {
  const result =
    await pool.query(
      `
        SELECT *
        FROM rooms
        WHERE guild_id = $1
      `,
      [
        guildId
      ]
    );

  return result.rows;
}

async function saveRoom({
  guildId,
  channelId,
  ownerId,
  categoryId,
  controlMessageId = null,
  dbClient = pool
}) {
  const result =
    await dbClient.query(
      `
        INSERT INTO rooms (
          guild_id,
          channel_id,
          owner_id,
          category_id,
          control_message_id
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5
        )
        ON CONFLICT (channel_id)
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
        RETURNING *
      `,
      [
        guildId,
        channelId,
        ownerId,
        categoryId,
        controlMessageId
      ]
    );

  return result.rows[0];
}

async function setControlMessage(
  channelId,
  messageId
) {
  await pool.query(
    `
      UPDATE rooms
      SET control_message_id = $1
      WHERE channel_id = $2
    `,
    [
      messageId,
      channelId
    ]
  );
}

async function updateRoomOwner(
  channelId,
  ownerId
) {
  const result =
    await pool.query(
      `
        UPDATE rooms
        SET owner_id = $1
        WHERE channel_id = $2
        RETURNING *
      `,
      [
        ownerId,
        channelId
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}

async function deleteRoomRecord(
  channelId
) {
  await pool.query(
    `
      DELETE FROM rooms
      WHERE channel_id = $1
    `,
    [
      channelId
    ]
  );
}

function isSnowflake(
  value
) {
  return (
    typeof value === 'string' &&
    /^\d{16,22}$/.test(value)
  );
}

function cleanDisplayName(
  value
) {
  return String(
    value || ''
  )
    .replace(
      /[\r\n\t`]/g,
      ' '
    )
    .replace(
      /\s+/g,
      ' '
    )
    .trim()
    .slice(
      0,
      50
    );
}

function cleanRoomName(
  value
) {
  let name =
    String(
      value || ''
    )
      .replace(
        /[\r\n\t]/g,
        ' '
      )
      .replace(
        /\s+/g,
        ' '
      )
      .trim();

  if (
    name.startsWith(
      ROOM_PREFIX
    )
  ) {
    name =
      name.slice(
        ROOM_PREFIX.length
      ).trim();
  }

  name =
    name.slice(
      0,
      80
    );

  return (
    name ||
    'Phòng thoại'
  );
}

function safeMemberName(
  member
) {
  return cleanDisplayName(
    member?.displayName ||
    member?.user?.globalName ||
    member?.user?.username ||
    'Thành viên'
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
        hour:
          '2-digit',
        minute:
          '2-digit',
        second:
          '2-digit',
        day:
          '2-digit',
        month:
          '2-digit',
        year:
          'numeric',
        hour12:
          false
      }
    ).formatToParts(
      date
    );

  const values =
    Object.fromEntries(
      parts.map(
        part => [
          part.type,
          part.value
        ]
      )
    );

  return (
    `${values.hour}:` +
    `${values.minute}:` +
    `${values.second} ` +
    `${values.day}/` +
    `${values.month}/` +
    `${values.year}`
  );
}

function relativeTimestamp(
  timeMs
) {
  return (
    `<t:${Math.floor(
      timeMs / 1000
    )}:R>`
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
function selectedMemberKey(
  guildId,
  channelId,
  ownerId
) {
  return (
    `${guildId}:` +
    `${channelId}:` +
    `${ownerId}`
  );
}

function setSelectedMember(
  guildId,
  channelId,
  ownerId,
  memberId
) {
  const key =
    selectedMemberKey(
      guildId,
      channelId,
      ownerId
    );

  selectedMembers.set(
    key,
    {
      memberId,
      expiresAt:
        Date.now() +
        10 * 60 * 1000
    }
  );
}

function getSelectedMemberId(
  guildId,
  channelId,
  ownerId
) {
  const key =
    selectedMemberKey(
      guildId,
      channelId,
      ownerId
    );

  const data =
    selectedMembers.get(
      key
    );

  if (!data) {
    return null;
  }

  if (
    data.expiresAt <=
    Date.now()
  ) {
    selectedMembers.delete(
      key
    );

    return null;
  }

  return data.memberId;
}

function clearSelectedMember(
  guildId,
  channelId,
  ownerId
) {
  selectedMembers.delete(
    selectedMemberKey(
      guildId,
      channelId,
      ownerId
    )
  );
}

function clearSelectionsForChannel(
  guildId,
  channelId
) {
  const prefix =
    `${guildId}:${channelId}:`;

  for (
    const key
    of selectedMembers.keys()
  ) {
    if (
      key.startsWith(
        prefix
      )
    ) {
      selectedMembers.delete(
        key
      );
    }
  }
}

function setupSessionKey(
  guildId,
  userId
) {
  return (
    `${guildId}:${userId}`
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
    setupSessions.get(
      key
    );

  if (!session) {
    return null;
  }

  if (
    session.expiresAt <=
    Date.now()
  ) {
    setupSessions.delete(
      key
    );

    return null;
  }

  return session;
}

function saveSetupSession(
  guildId,
  userId,
  data = {}
) {
  const key =
    setupSessionKey(
      guildId,
      userId
    );

  const old =
    getSetupSession(
      guildId,
      userId
    ) || {};

  const session = {
    ...old,
    ...data,
    guildId,
    userId,
    expiresAt:
      Date.now() +
      SETUP_TIMEOUT_MS
  };

  setupSessions.set(
    key,
    session
  );

  return session;
}

function deleteSetupSession(
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

function transferKey(
  channelId
) {
  return String(
    channelId
  );
}

function getPendingTransfer(
  channelId
) {
  const key =
    transferKey(
      channelId
    );

  const transfer =
    pendingTransfers.get(
      key
    );

  if (!transfer) {
    return null;
  }

  if (
    transfer.expiresAt <=
    Date.now()
  ) {
    pendingTransfers.delete(
      key
    );

    return null;
  }

  return transfer;
}

function clearPendingTransfer(
  channelId
) {
  const key =
    transferKey(
      channelId
    );

  const transfer =
    pendingTransfers.get(
      key
    );

  if (
    transfer?.timer
  ) {
    clearTimeout(
      transfer.timer
    );
  }

  pendingTransfers.delete(
    key
  );
}

function cooldownKey(
  userId,
  action
) {
  return (
    `${userId}:${action}`
  );
}

function useCooldown(
  userId,
  action,
  duration =
    ACTION_COOLDOWN_MS
) {
  const key =
    cooldownKey(
      userId,
      action
    );

  const now =
    Date.now();

  const until =
    cooldowns.get(
      key
    ) || 0;

  if (
    until > now
  ) {
    return (
      until - now
    );
  }

  cooldowns.set(
    key,
    now + duration
  );

  const timer =
    setTimeout(
      () => {
        if (
          cooldowns.get(
            key
          ) <=
          Date.now()
        ) {
          cooldowns.delete(
            key
          );
        }
      },
      duration + 1000
    );

  timer.unref?.();

  return 0;
}

async function withLock(
  map,
  key,
  task
) {
  const lockKey =
    String(key);

  const previous =
    map.get(
      lockKey
    ) ||
    Promise.resolve();

  let release;

  const current =
    new Promise(
      resolve => {
        release =
          resolve;
      }
    );

  const chain =
    previous
      .catch(
        () => {}
      )
      .then(
        () => current
      );

  map.set(
    lockKey,
    chain
  );

  await previous.catch(
    () => {}
  );

  try {
    return await task();
  } finally {
    release();

    if (
      map.get(
        lockKey
      ) === chain
    ) {
      map.delete(
        lockKey
      );
    }
  }
}

function withPanelLock(
  channelId,
  task
) {
  return withLock(
    panelLocks,
    channelId,
    task
  );
}

function withCreateLock(
  guildId,
  ownerId,
  task
) {
  return withLock(
    createLocks,
    `${guildId}:${ownerId}`,
    task
  );
}

function missingPermissions(
  permissions
) {
  if (!permissions) {
    return [
      ...REQUIRED_PERMISSIONS
    ];
  }

  return (
    REQUIRED_PERMISSIONS.filter(
      permission =>
        !permissions.has(
          permission
        )
    )
  );
}

async function getBotMember(
  guild
) {
  if (!guild) {
    return null;
  }

  if (
    guild.members.me
  ) {
    return guild.members.me;
  }

  try {
    return await guild.members.fetchMe();
  } catch (error) {
    logError(
      'FETCH_BOT_MEMBER',
      error
    );

    return null;
  }
}

async function getGuildMember(
  guild,
  memberId
) {
  if (
    !guild ||
    !isSnowflake(
      String(memberId)
    )
  ) {
    return null;
  }

  const id =
    String(memberId);

  const cached =
    guild.members.cache.get(
      id
    );

  if (cached) {
    return cached;
  }

  try {
    return await guild.members.fetch(
      id
    );
  } catch {
    return null;
  }
}

async function resolveOverwriteTarget(
  guild,
  targetId
) {
  if (
    !guild ||
    !isSnowflake(
      String(targetId)
    )
  ) {
    return null;
  }

  const id =
    String(targetId);

  const role =
    guild.roles.cache.get(
      id
    );

  if (role) {
    return {
      id: role.id,
      type:
        PermissionOverwriteType.Role
    };
  }

  const member =
    await getGuildMember(
      guild,
      id
    );

  if (member) {
    return {
      id: member.id,
      type:
        PermissionOverwriteType.Member
    };
  }

  return null;
}

async function safeEditOverwrite(
  channel,
  targetId,
  permissions,
  reason
) {
  if (
    !channel?.guild
  ) {
    throw new Error(
      'Kênh Discord không hợp lệ.'
    );
  }

  const target =
    await resolveOverwriteTarget(
      channel.guild,
      targetId
    );

  if (!target) {
    throw new Error(
      'Không tìm thấy thành viên hoặc vai trò hợp lệ để cập nhật quyền.'
    );
  }

  return (
    channel.permissionOverwrites.edit(
      target.id,
      permissions,
      {
        type:
          target.type,
        reason
      }
    )
  );
}

async function safeDeleteOverwrite(
  channel,
  targetId,
  reason
) {
  if (
    !channel?.guild ||
    !isSnowflake(
      String(targetId)
    )
  ) {
    return false;
  }

  const overwrite =
    channel.permissionOverwrites.cache.get(
      String(targetId)
    );

  if (!overwrite) {
    return true;
  }

  try {
    await overwrite.delete(
      reason
    );

    return true;
  } catch (error) {
    logError(
      'DELETE_OVERWRITE',
      error
    );

    return false;
  }
}

async function ensureBotRoomPermissions(
  channel
) {
  const botMember =
    await getBotMember(
      channel.guild
    );

  if (!botMember) {
    throw new Error(
      'Không tìm thấy tài khoản bot trong server.'
    );
  }

  await safeEditOverwrite(
    channel,
    botMember.id,
    {
      ViewChannel: true,
      Connect: true,
      SendMessages: true,
      ReadMessageHistory: true,
      ManageChannels: true,
      ManageRoles: true,
      MoveMembers: true
    },
    `${BOT_NAME}: bảo đảm quyền quản lý phòng`
  );
}

async function grantOwnerPermissions(
  channel,
  ownerId
) {
  const member =
    await getGuildMember(
      channel.guild,
      ownerId
    );

  if (!member) {
    throw new Error(
      'Không tìm thấy chủ phòng trong server.'
    );
  }

  await safeEditOverwrite(
    channel,
    member.id,
    {
      ViewChannel: true,
      Connect: true
    },
    `${BOT_NAME}: cấp quyền chủ phòng`
  );
}

async function removeOwnerPermissions(
  channel,
  ownerId
) {
  if (
    !isSnowflake(
      String(ownerId)
    )
  ) {
    return false;
  }

  return safeDeleteOverwrite(
    channel,
    String(ownerId),
    `${BOT_NAME}: thu hồi quyền chủ phòng cũ`
  );
}

async function setRoomLocked(
  channel,
  locked
) {
  await safeEditOverwrite(
    channel,
    channel.guild.roles.everyone.id,
    {
      Connect:
        locked
          ? false
          : null
    },
    locked
      ? `${BOT_NAME}: khóa phòng`
      : `${BOT_NAME}: mở phòng`
  );
}

async function setRoomHidden(
  channel,
  hidden
) {
  await safeEditOverwrite(
    channel,
    channel.guild.roles.everyone.id,
    {
      ViewChannel:
        hidden
          ? false
          : null
    },
    hidden
      ? `${BOT_NAME}: ẩn phòng`
      : `${BOT_NAME}: hiện phòng`
  );
}

async function inviteMember(
  channel,
  member
) {
  if (
    !member ||
    member.guild.id !==
      channel.guild.id
  ) {
    throw new Error(
      'Thành viên không hợp lệ.'
    );
  }

  await safeEditOverwrite(
    channel,
    member.id,
    {
      ViewChannel: true,
      Connect: true
    },
    `${BOT_NAME}: mời thành viên vào phòng`
  );
}

async function denyMember(
  channel,
  member
) {
  if (
    !member ||
    member.guild.id !==
      channel.guild.id
  ) {
    throw new Error(
      'Thành viên không hợp lệ.'
    );
  }

  await safeEditOverwrite(
    channel,
    member.id,
    {
      ViewChannel: false,
      Connect: false
    },
    `${BOT_NAME}: cấm thành viên khỏi phòng`
  );

  if (
    member.voice?.channelId ===
    channel.id
  ) {
    await member.voice.disconnect(
      `${BOT_NAME}: thành viên bị cấm khỏi phòng`
    );
  }
}

async function kickMember(
  channel,
  member
) {
  if (
    !member ||
    member.guild.id !==
      channel.guild.id
  ) {
    throw new Error(
      'Thành viên không hợp lệ.'
    );
  }

  if (
    member.voice?.channelId !==
    channel.id
  ) {
    throw new Error(
      'Thành viên được chọn không còn ở trong phòng này.'
    );
  }

  await member.voice.disconnect(
    `${BOT_NAME}: chủ phòng đã đuổi thành viên`
  );
}

async function clearMemberOverwrites(
  channel,
  keepMemberIds = []
) {
  const keep =
    new Set(
      keepMemberIds.map(
        id =>
          String(id)
      )
    );

  for (
    const overwrite
    of channel.permissionOverwrites.cache.values()
  ) {
    if (
      overwrite.type !==
      PermissionOverwriteType.Member
    ) {
      continue;
    }

    if (
      keep.has(
        overwrite.id
      )
    ) {
      continue;
    }

    try {
      await overwrite.delete(
        `${BOT_NAME}: đặt lại quyền thành viên`
      );
    } catch (error) {
      logError(
        'RESET_MEMBER_OVERWRITE',
        error
      );

      throw error;
    }
  }
}

async function resetRoom(
  channel,
  ownerId
) {
  const botMember =
    await getBotMember(
      channel.guild
    );

  if (!botMember) {
    throw new Error(
      'Không tìm thấy bot trong server.'
    );
  }

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
    `${BOT_NAME}: đặt lại giới hạn`
  );

  await channel.setRTCRegion(
    null,
    `${BOT_NAME}: đặt lại khu vực tự động`
  );

  await clearMemberOverwrites(
    channel,
    [
      String(ownerId),
      botMember.id
    ]
  );

  await grantOwnerPermissions(
    channel,
    String(ownerId)
  );

  await ensureBotRoomPermissions(
    channel
  );
}

function deleteReplyLater(
  interaction,
  delay
) {
  const timer =
    setTimeout(
      async () => {
        try {
          if (
            interaction.deferred ||
            interaction.replied
          ) {
            await interaction.deleteReply();
          }
        } catch {
        }
      },
      delay
    );

  timer.unref?.();
}

function deleteMessageLater(
  message,
  delay
) {
  if (!message) {
    return;
  }

  const timer =
    setTimeout(
      async () => {
        try {
          await message.delete();
        } catch {
        }
      },
      delay
    );

  timer.unref?.();
}

async function tempReply(
  interaction,
  content,
  {
    error = false
  } = {}
) {
  const delay =
    error
      ? ERROR_DELETE_MS
      : SUCCESS_DELETE_MS;

  const payload = {
    content,
    ephemeral: true
  };

  try {
    if (
      interaction.deferred
    ) {
      await interaction.editReply({
        content
      });

      deleteReplyLater(
        interaction,
        delay
      );

      return null;
    }

    if (
      interaction.replied
    ) {
      const message =
        await interaction.followUp({
          ...payload,
          fetchReply: true
        });

      deleteMessageLater(
        message,
        delay
      );

      return message;
    }

    await interaction.reply(
      payload
    );

    deleteReplyLater(
      interaction,
      delay
    );

    return null;
  } catch (errorObject) {
    logError(
      'TEMP_REPLY',
      errorObject
    );

    return null;
  }
}

async function tempFollowUp(
  interaction,
  content,
  {
    error = false
  } = {}
) {
  const delay =
    error
      ? ERROR_DELETE_MS
      : SUCCESS_DELETE_MS;

  try {
    const message =
      await interaction.followUp({
        content,
        ephemeral: true,
        fetchReply: true
      });

    deleteMessageLater(
      message,
      delay
    );

    return message;
  } catch (errorObject) {
    logError(
      'TEMP_FOLLOWUP',
      errorObject
    );

    return null;
  }
}

async function safeDeferUpdate(
  interaction
) {
  if (
    interaction.deferred ||
    interaction.replied
  ) {
    return true;
  }

  try {
    await interaction.deferUpdate();

    return true;
  } catch (error) {
    logError(
      'DEFER_UPDATE',
      error
    );

    return false;
  }
}

async function safeDeferReply(
  interaction,
  ephemeral = true
) {
  if (
    interaction.deferred ||
    interaction.replied
  ) {
    return true;
  }

  try {
    await interaction.deferReply({
      ephemeral
    });

    return true;
  } catch (error) {
    logError(
      'DEFER_REPLY',
      error
    );

    return false;
  }
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

  const regions =
    await client.fetchVoiceRegions();

  const normalized =
    regions
      .map(
        region => ({
          id:
            String(
              region.id
            ),
          name:
            String(
              region.name ||
              region.id
            ),
          optimal:
            Boolean(
              region.optimal
            ),
          deprecated:
            Boolean(
              region.deprecated
            ),
          custom:
            Boolean(
              region.custom
            )
        })
      )
      .filter(
        region =>
          !region.deprecated
      )
      .sort(
        (a, b) => {
          if (
            a.optimal !==
            b.optimal
          ) {
            return a.optimal
              ? -1
              : 1;
          }

          return (
            a.name.localeCompare(
              b.name,
              'vi'
            )
          );
        }
      );

  regionCache = {
    regions:
      normalized,
    expiresAt:
      now +
      30 * 60 * 1000
  };

  return normalized;
}

async function validateRegion(
  regionId
) {
  if (
    !regionId ||
    regionId ===
      'automatic'
  ) {
    return null;
  }

  let regions =
    await getVoiceRegions();

  let found =
    regions.find(
      region =>
        region.id ===
        regionId
    );

  if (!found) {
    regions =
      await getVoiceRegions(
        true
      );

    found =
      regions.find(
        region =>
          region.id ===
          regionId
      );
  }

  return (
    found ||
    null
  );
}

function getRoomState(
  channel
) {
  const everyone =
    channel.permissionOverwrites.cache.get(
      channel.guild.roles.everyone.id
    );

  const locked =
    everyone?.deny?.has(
      PermissionsBitField.Flags.Connect
    ) || false;

  const hidden =
    everyone?.deny?.has(
      PermissionsBitField.Flags.ViewChannel
    ) || false;

  return {
    locked,
    hidden
  };
}

async function getRoomOwnerMember(
  room,
  guild
) {
  if (
    !room ||
    !guild
  ) {
    return null;
  }

  return getGuildMember(
    guild,
    String(
      room.owner_id
    )
  );
}

async function getSelectedMember(
  guild,
  channelId,
  ownerId
) {
  const memberId =
    getSelectedMemberId(
      guild.id,
      channelId,
      ownerId
    );

  if (!memberId) {
    return null;
  }

  const member =
    await getGuildMember(
      guild,
      memberId
    );

  if (!member) {
    clearSelectedMember(
      guild.id,
      channelId,
      ownerId
    );

    return null;
  }

  return member;
}

function canManageSetup(
  interaction
) {
  return Boolean(
    interaction.memberPermissions?.has(
      PermissionsBitField.Flags.ManageGuild
    ) ||
    interaction.memberPermissions?.has(
      PermissionsBitField.Flags.Administrator
    )
  );
}

async function validateSetupPermissions(
  guild,
  buttonCategory = null,
  blogCategory = null
) {
  const botMember =
    await getBotMember(
      guild
    );

  if (!botMember) {
    return {
      ok: false,
      missing: [
        'Không tìm thấy bot trong server'
      ]
    };
  }

  const globalMissing =
    missingPermissions(
      botMember.permissions
    );

  const missingNames =
    permissionNames(
      globalMissing
    );

  for (
    const category
    of [
      buttonCategory,
      blogCategory
    ]
  ) {
    if (!category) {
      continue;
    }

    const permissions =
      category.permissionsFor(
        botMember
      );

    const categoryMissing =
      missingPermissions(
        permissions
      );

    for (
      const name
      of permissionNames(
        categoryMissing
      )
    ) {
      const item =
        `${name} (${category.name})`;

      if (
        !missingNames.includes(
          item
        )
      ) {
        missingNames.push(
          item
        );
      }
    }
  }

  return {
    ok:
      missingNames.length === 0,
    missing:
      missingNames
  };
}
function buildSetupPanel(
  session
) {
  const displayName =
    cleanDisplayName(
      session?.displayName
    );

  const buttonCategoryId =
    session?.buttonCategoryId
      ? String(
          session.buttonCategoryId
        )
      : null;

  const blogCategoryId =
    session?.blogCategoryId
      ? String(
          session.blogCategoryId
        )
      : null;

  const ready =
    Boolean(
      displayName &&
      buttonCategoryId &&
      blogCategoryId
    );

  const embed =
    new EmbedBuilder()
      .setTitle(
        '⚙️ Thiết lập Voice HDK'
      )
      .setDescription(
        [
          '🏷️ **Tên Server**',
          displayName ||
            'Chưa đặt',
          '',
          '📁 **Danh mục đặt nút**',
          buttonCategoryId
            ? `<#${buttonCategoryId}>`
            : 'Chưa chọn',
          '',
          '📁 **Danh mục đặt Blog**',
          blogCategoryId
            ? `<#${blogCategoryId}>`
            : 'Chưa chọn'
        ].join(
          '\n'
        )
      )
      .setFooter({
        text:
          `${BOT_NAME} • Thiết lập hệ thống`
      });

  const nameRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'setup_name'
          )
          .setLabel(
            'Đặt tên Server'
          )
          .setEmoji(
            '🏷️'
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  const buttonCategoryRow =
    new ActionRowBuilder()
      .addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(
            'setup_button_category'
          )
          .setPlaceholder(
            '📁 Chọn danh mục đặt nút'
          )
          .setChannelTypes(
            ChannelType.GuildCategory
          )
          .setMinValues(
            1
          )
          .setMaxValues(
            1
          )
      );

  const blogCategoryRow =
    new ActionRowBuilder()
      .addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(
            'setup_blog_category'
          )
          .setPlaceholder(
            '📁 Chọn danh mục đặt Blog'
          )
          .setChannelTypes(
            ChannelType.GuildCategory
          )
          .setMinValues(
            1
          )
          .setMaxValues(
            1
          )
      );

  const installRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'setup_install'
          )
          .setLabel(
            'Cài đặt'
          )
          .setEmoji(
            '✅'
          )
          .setStyle(
            ButtonStyle.Success
          )
          .setDisabled(
            !ready
          )
      );

  return {
    embeds: [
      embed
    ],
    components: [
      nameRow,
      buttonCategoryRow,
      blogCategoryRow,
      installRow
    ]
  };
}

function buildReinstallPanel() {
  const embed =
    new EmbedBuilder()
      .setTitle(
        '⚠️ CÀI ĐẶT LẠI VOICE HDK'
      )
      .setDescription(
        [
          'Server này đã được cài đặt Voice HDK.',
          '',
          'Tiếp tục sẽ xóa hệ thống Voice HDK cũ',
          'và cho phép bạn thiết lập lại từ đầu.'
        ].join(
          '\n'
        )
      );

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'setup_reinstall_confirm'
          )
          .setLabel(
            'Cài đặt lại'
          )
          .setEmoji(
            '♻️'
          )
          .setStyle(
            ButtonStyle.Danger
          ),
        new ButtonBuilder()
          .setCustomId(
            'setup_reinstall_cancel'
          )
          .setLabel(
            'Hủy'
          )
          .setEmoji(
            '✖️'
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  return {
    embeds: [
      embed
    ],
    components: [
      row
    ]
  };
}

function buildCreateRoomPanel(
  displayName
) {
  const safeName =
    cleanDisplayName(
      displayName
    ) ||
    'Voice HDK';

  const embed =
    new EmbedBuilder()
      .setTitle(
        '🔊 TẠO PHÒNG THOẠI'
      )
      .setDescription(
        [
          'Nhấn nút bên dưới để tạo phòng Voice riêng.',
          '',
          'Phòng sẽ tự động được quản lý bởi Voice HDK.'
        ].join(
          '\n'
        )
      )
      .setFooter({
        text:
          `✦ ${BOT_NAME} • ${safeName}`
      });

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'room_create'
          )
          .setLabel(
            'Tạo phòng'
          )
          .setEmoji(
            '➕'
          )
          .setStyle(
            ButtonStyle.Success
          )
      );

  return {
    embeds: [
      embed
    ],
    components: [
      row
    ]
  };
}

function buildSetupSuccessPanel({
  displayName,
  buttonCategoryId,
  blogCategoryId
}) {
  const embed =
    new EmbedBuilder()
      .setTitle(
        '🎉 CÀI ĐẶT VOICE HDK THÀNH CÔNG!'
      )
      .setDescription(
        [
          'Chúc mừng! Voice HDK đã được cài đặt thành công',
          'và hiện đã sẵn sàng để sử dụng.',
          '',
          `🏷️ **Tên Server:** ${cleanDisplayName(displayName)}`,
          `📁 **Danh mục đặt nút:** <#${buttonCategoryId}>`,
          `📁 **Danh mục đặt Blog:** <#${blogCategoryId}>`,
          '',
          'Nếu có bất kỳ thắc mắc hoặc cần hỗ trợ:',
          '👤 **Huỳnh Duy Khánh**',
          '☎️ **0988850044**',
          '',
          'Cảm ơn bạn đã sử dụng Voice HDK ❤️'
        ].join(
          '\n'
        )
      )
      .setFooter({
        text:
          `✦ ${BOT_NAME} • ${cleanDisplayName(displayName)}`
      });

  return {
    embeds: [
      embed
    ],
    components: []
  };
}

async function handleSetupCommand(
  interaction
) {
  await safeDeferReply(
    interaction,
    true
  );

  if (!interaction.guild) {
    await tempReply(
      interaction,
      '❌ Lệnh này chỉ sử dụng trong server.',
      {
        error: true
      }
    );

    return;
  }

  if (
    !canManageSetup(
      interaction
    )
  ) {
    await tempReply(
      interaction,
      '❌ Bạn cần quyền **Quản lý Server** để cài đặt Voice HDK.',
      {
        error: true
      }
    );

    return;
  }

  const existing =
    await getGenerator(
      interaction.guild.id
    );

  if (
    existing?.create_channel_id ||
    existing?.chat_log_channel_id ||
    existing?.action_log_channel_id
  ) {
    await interaction.editReply(
      buildReinstallPanel()
    );

    return;
  }

  const session =
    saveSetupSession(
      interaction.guild.id,
      interaction.user.id,
      {
        displayName: '',
        buttonCategoryId:
          null,
        blogCategoryId:
          null
      }
    );

  await interaction.editReply(
    buildSetupPanel(
      session
    )
  );
}

async function handleSetupNameButton(
  interaction
) {
  if (
    !interaction.guild ||
    !canManageSetup(
      interaction
    )
  ) {
    await tempReply(
      interaction,
      '❌ Bạn không có quyền thực hiện thao tác này.',
      {
        error: true
      }
    );

    return;
  }

  let session =
    getSetupSession(
      interaction.guild.id,
      interaction.user.id
    );

  if (!session) {
    session =
      saveSetupSession(
        interaction.guild.id,
        interaction.user.id,
        {
          displayName: '',
          buttonCategoryId:
            null,
          blogCategoryId:
            null
        }
      );
  }

  const modal =
    new ModalBuilder()
      .setCustomId(
        'setup_name_modal'
      )
      .setTitle(
        'Đặt tên Server'
      );

  const input =
    new TextInputBuilder()
      .setCustomId(
        'setup_display_name'
      )
      .setLabel(
        'Tên hiển thị'
      )
      .setPlaceholder(
        'Ví dụ: ABCD'
      )
      .setStyle(
        TextInputStyle.Short
      )
      .setMinLength(
        1
      )
      .setMaxLength(
        50
      )
      .setRequired(
        true
      );

  if (
    session.displayName
  ) {
    input.setValue(
      session.displayName
    );
  }

  modal.addComponents(
    new ActionRowBuilder()
      .addComponents(
        input
      )
  );

  await interaction.showModal(
    modal
  );
}

async function handleSetupNameModal(
  interaction
) {
  await safeDeferReply(
    interaction,
    true
  );

  if (
    !interaction.guild ||
    !canManageSetup(
      interaction
    )
  ) {
    await tempReply(
      interaction,
      '❌ Bạn không có quyền thực hiện thao tác này.',
      {
        error: true
      }
    );

    return;
  }

  const displayName =
    cleanDisplayName(
      interaction.fields.getTextInputValue(
        'setup_display_name'
      )
    );

  if (!displayName) {
    await tempReply(
      interaction,
      '❌ Tên Server không hợp lệ.',
      {
        error: true
      }
    );

    return;
  }

  const session =
    saveSetupSession(
      interaction.guild.id,
      interaction.user.id,
      {
        displayName
      }
    );

  await interaction.editReply(
    {
      content:
        `✅ Đã đặt tên Server: **${displayName}**`
    }
  );

  deleteReplyLater(
    interaction,
    SUCCESS_DELETE_MS
  );

  if (
    interaction.message
  ) {
    try {
      await interaction.message.edit(
        buildSetupPanel(
          session
        )
      );
    } catch (error) {
      logError(
        'SETUP_REFRESH_AFTER_NAME',
        error
      );
    }
  }
}

async function handleSetupCategorySelect(
  interaction,
  type
) {
  await safeDeferUpdate(
    interaction
  );

  if (
    !interaction.guild ||
    !canManageSetup(
      interaction
    )
  ) {
    await tempFollowUp(
      interaction,
      '❌ Bạn không có quyền thực hiện thao tác này.',
      {
        error: true
      }
    );

    return;
  }

  const categoryId =
    interaction.values?.[0];

  if (
    !isSnowflake(
      String(categoryId)
    )
  ) {
    await tempFollowUp(
      interaction,
      '❌ Danh mục được chọn không hợp lệ.',
      {
        error: true
      }
    );

    return;
  }

  const category =
    interaction.guild.channels.cache.get(
      categoryId
    ) ||
    await interaction.guild.channels.fetch(
      categoryId
    ).catch(
      () => null
    );

  if (
    !category ||
    category.type !==
      ChannelType.GuildCategory
  ) {
    await tempFollowUp(
      interaction,
      '❌ Vui lòng chọn đúng một Danh mục Discord.',
      {
        error: true
      }
    );

    return;
  }

  const data =
    type === 'button'
      ? {
          buttonCategoryId:
            category.id
        }
      : {
          blogCategoryId:
            category.id
        };

  const session =
    saveSetupSession(
      interaction.guild.id,
      interaction.user.id,
      data
    );

  try {
    await interaction.editReply(
      buildSetupPanel(
        session
      )
    );
  } catch (error) {
    logError(
      'SETUP_CATEGORY_REFRESH',
      error
    );
  }
}

async function safeDeleteManagedChannel(
  guild,
  channelId,
  reason
) {
  if (
    !guild ||
    !isSnowflake(
      String(channelId)
    )
  ) {
    return false;
  }

  let channel =
    guild.channels.cache.get(
      String(channelId)
    );

  if (!channel) {
    channel =
      await guild.channels.fetch(
        String(channelId)
      ).catch(
        () => null
      );
  }

  if (!channel) {
    return true;
  }

  try {
    await channel.delete(
      reason
    );

    return true;
  } catch (error) {
    logError(
      'DELETE_MANAGED_CHANNEL',
      error
    );

    return false;
  }
}

async function cleanupGuildInstallation(
  guild
) {
  const generator =
    await getGenerator(
      guild.id
    );

  if (!generator) {
    return;
  }

  const roomRows =
    await getGuildRooms(
      guild.id
    );

  for (
    const room
    of roomRows
  ) {
    clearPendingTransfer(
      String(
        room.channel_id
      )
    );

    clearSelectionsForChannel(
      guild.id,
      String(
        room.channel_id
      )
    );

    await safeDeleteManagedChannel(
      guild,
      String(
        room.channel_id
      ),
      `${BOT_NAME}: cài đặt lại hệ thống`
    );

    await deleteRoomRecord(
      String(
        room.channel_id
      )
    );
  }

  const managedIds =
    [
      generator.create_channel_id,
      generator.chat_log_channel_id,
      generator.action_log_channel_id
    ]
      .filter(
        Boolean
      )
      .map(
        id =>
          String(id)
      );

  for (
    const channelId
    of new Set(
      managedIds
    )
  ) {
    await safeDeleteManagedChannel(
      guild,
      channelId,
      `${BOT_NAME}: cài đặt lại hệ thống`
    );
  }

  await deleteGenerator(
    guild.id
  );
}

async function handleReinstallConfirm(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  if (
    !interaction.guild ||
    !canManageSetup(
      interaction
    )
  ) {
    await tempFollowUp(
      interaction,
      '❌ Bạn không có quyền cài đặt lại Voice HDK.',
      {
        error: true
      }
    );

    return;
  }

  try {
    await cleanupGuildInstallation(
      interaction.guild
    );

    const session =
      saveSetupSession(
        interaction.guild.id,
        interaction.user.id,
        {
          displayName: '',
          buttonCategoryId:
            null,
          blogCategoryId:
            null
        }
      );

    await interaction.editReply(
      buildSetupPanel(
        session
      )
    );
  } catch (error) {
    logError(
      'SETUP_REINSTALL',
      error
    );

    await tempFollowUp(
      interaction,
      '❌ Không thể cài đặt lại an toàn. Hệ thống đã dừng thao tác để tránh xóa nhầm dữ liệu.',
      {
        error: true
      }
    );
  }
}

async function handleReinstallCancel(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  deleteSetupSession(
    interaction.guildId,
    interaction.user.id
  );

  try {
    await interaction.editReply({
      content:
        '✖️ Đã hủy cài đặt lại Voice HDK.',
      embeds: [],
      components: []
    });
  } catch (error) {
    logError(
      'SETUP_REINSTALL_CANCEL',
      error
    );
  }

  deleteReplyLater(
    interaction,
    SUCCESS_DELETE_MS
  );
}

async function createManagedTextChannel(
  guild,
  category,
  name,
  topic
) {
  const botMember =
    await getBotMember(
      guild
    );

  if (!botMember) {
    throw new Error(
      'Không tìm thấy bot trong server.'
    );
  }

  return guild.channels.create({
    name,
    type:
      ChannelType.GuildText,
    parent:
      category.id,
    topic,
    reason:
      `${BOT_NAME}: cài đặt hệ thống`,
    permissionOverwrites: [
      {
        id:
          guild.roles.everyone.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.ReadMessageHistory
        ]
      },
      {
        id:
          botMember.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.EmbedLinks,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageChannels
        ]
      }
    ]
  });
}

async function rollbackCreatedChannels(
  channels
) {
  for (
    const channel
    of [...channels].reverse()
  ) {
    if (!channel) {
      continue;
    }

    try {
      await channel.delete(
        `${BOT_NAME}: hoàn tác cài đặt lỗi`
      );
    } catch (error) {
      logError(
        'SETUP_ROLLBACK_CHANNEL',
        error
      );
    }
  }
}

async function installGuildSystem(
  guild,
  session
) {
  const displayName =
    cleanDisplayName(
      session.displayName
    );

  if (!displayName) {
    throw new Error(
      'Bạn chưa đặt tên Server.'
    );
  }

  const buttonCategory =
    guild.channels.cache.get(
      String(
        session.buttonCategoryId
      )
    ) ||
    await guild.channels.fetch(
      String(
        session.buttonCategoryId
      )
    ).catch(
      () => null
    );

  const blogCategory =
    guild.channels.cache.get(
      String(
        session.blogCategoryId
      )
    ) ||
    await guild.channels.fetch(
      String(
        session.blogCategoryId
      )
    ).catch(
      () => null
    );

  if (
    !buttonCategory ||
    buttonCategory.type !==
      ChannelType.GuildCategory
  ) {
    throw new Error(
      'Danh mục đặt nút không còn tồn tại.'
    );
  }

  if (
    !blogCategory ||
    blogCategory.type !==
      ChannelType.GuildCategory
  ) {
    throw new Error(
      'Danh mục đặt Blog không còn tồn tại.'
    );
  }

  const permissionCheck =
    await validateSetupPermissions(
      guild,
      buttonCategory,
      blogCategory
    );

  if (
    !permissionCheck.ok
  ) {
    throw new Error(
      'Bot đang thiếu quyền: ' +
      permissionCheck.missing.join(
        ', '
      )
    );
  }

  const created = [];

  try {
    const createChannel =
      await createManagedTextChannel(
        guild,
        buttonCategory,
        CREATE_CHANNEL_NAME,
        `${BOT_NAME} • Nút tạo phòng`
      );

    created.push(
      createChannel
    );

    const chatLogChannel =
      await createManagedTextChannel(
        guild,
        blogCategory,
        CHAT_LOG_CHANNEL_NAME,
        `${BOT_NAME} • Nhật ký Chat`
      );

    created.push(
      chatLogChannel
    );

    const actionLogChannel =
      await createManagedTextChannel(
        guild,
        blogCategory,
        ACTION_LOG_CHANNEL_NAME,
        `${BOT_NAME} • Nhật ký Chức năng`
      );

    created.push(
      actionLogChannel
    );

    const createMessage =
      await createChannel.send(
        buildCreateRoomPanel(
          displayName
        )
      );

    let saved;

    try {
      saved =
        await saveGenerator({
          guildId:
            guild.id,
          displayName,
          buttonCategoryId:
            buttonCategory.id,
          blogCategoryId:
            blogCategory.id,
          createChannelId:
            createChannel.id,
          createMessageId:
            createMessage.id,
          chatLogChannelId:
            chatLogChannel.id,
          actionLogChannelId:
            actionLogChannel.id
        });
    } catch (error) {
      logError(
        'SETUP_SAVE_DATABASE',
        error
      );

      await rollbackCreatedChannels(
        created
      );

      throw new Error(
        'Không thể lưu cấu hình vào Database. Các kênh vừa tạo đã được hoàn tác.'
      );
    }

    return {
      generator:
        saved,
      buttonCategory,
      blogCategory,
      createChannel,
      chatLogChannel,
      actionLogChannel,
      createMessage
    };
  } catch (error) {
    if (
      created.length
    ) {
      await rollbackCreatedChannels(
        created
      );
    }

    throw error;
  }
}

async function handleSetupInstall(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  if (
    !interaction.guild ||
    !canManageSetup(
      interaction
    )
  ) {
    await tempFollowUp(
      interaction,
      '❌ Bạn không có quyền cài đặt Voice HDK.',
      {
        error: true
      }
    );

    return;
  }

  const session =
    getSetupSession(
      interaction.guild.id,
      interaction.user.id
    );

  if (!session) {
    await tempFollowUp(
      interaction,
      '❌ Phiên thiết lập đã hết hạn. Hãy chạy lại `/setup`.',
      {
        error: true
      }
    );

    return;
  }

  if (
    !cleanDisplayName(
      session.displayName
    ) ||
    !session.buttonCategoryId ||
    !session.blogCategoryId
  ) {
    await tempFollowUp(
      interaction,
      '❌ Vui lòng đặt tên Server và chọn đủ 2 Danh mục.',
      {
        error: true
      }
    );

    return;
  }

  const cooldown =
    useCooldown(
      interaction.user.id,
      'setup_install',
      5000
    );

  if (cooldown) {
    await tempFollowUp(
      interaction,
      '⏳ Vui lòng chờ một chút trước khi cài đặt lại.',
      {
        error: true
      }
    );

    return;
  }

  const existing =
    await getGenerator(
      interaction.guild.id
    );

  if (
    existing?.create_channel_id ||
    existing?.chat_log_channel_id ||
    existing?.action_log_channel_id
  ) {
    await tempFollowUp(
      interaction,
      '⚠️ Server đã có hệ thống Voice HDK. Hãy chạy `/setup` và chọn **Cài đặt lại** trước.',
      {
        error: true
      }
    );

    return;
  }

  try {
    const installed =
      await installGuildSystem(
        interaction.guild,
        session
      );

    deleteSetupSession(
      interaction.guild.id,
      interaction.user.id
    );

    await interaction.editReply(
      buildSetupSuccessPanel({
        displayName:
          installed.generator.display_name,
        buttonCategoryId:
          installed.buttonCategory.id,
        blogCategoryId:
          installed.blogCategory.id
      })
    );
  } catch (error) {
    logError(
      'SETUP_INSTALL',
      error
    );

    await tempFollowUp(
      interaction,
      `❌ Cài đặt thất bại: ${String(
        error?.message ||
        'Lỗi không xác định.'
      ).slice(0, 1500)}`,
      {
        error: true
      }
    );
  }
}
function roomDashboardLine(
  icon,
  label,
  value
) {
  const safeLabel =
    String(label)
      .slice(
        0,
        12
      )
      .padEnd(
        12,
        ' '
      );

  return (
    `${icon} ${safeLabel}${value}`
  );
}

function buildRoomDashboard(
  channel,
  owner,
  generator
) {
  const state =
    getRoomState(
      channel
    );

  const humans =
    channel.members.filter(
      member =>
        !member.user.bot
    );

  const limit =
    channel.userLimit > 0
      ? String(
          channel.userLimit
        )
      : '∞';

  const region =
    channel.rtcRegion
      ? String(
          channel.rtcRegion
        )
      : 'Tự động';

  const ownerName =
    safeMemberName(
      owner
    );

  const displayName =
    cleanDisplayName(
      generator?.display_name
    ) ||
    'Voice HDK';

  const titleName =
    cleanRoomName(
      channel.name
    )
      .toUpperCase()
      .slice(
        0,
        35
      );

  return [
    `🔊  ${titleName}`,
    '────────────────────────────',
    roomDashboardLine(
      '👑',
      'Chủ phòng',
      ownerName
    ),
    roomDashboardLine(
      '👥',
      'Thành viên',
      `${humans.size} / ${limit}`
    ),
    roomDashboardLine(
      state.locked
        ? '🔒'
        : '🔓',
      'Phòng',
      state.locked
        ? 'Đang khóa'
        : 'Đang mở'
    ),
    roomDashboardLine(
      state.hidden
        ? '🙈'
        : '👁️',
      'Hiển thị',
      state.hidden
        ? 'Đang ẩn'
        : 'Công khai'
    ),
    roomDashboardLine(
      '🌐',
      'Khu vực',
      region
    ),
    '────────────────────────────',
    `✦ ${BOT_NAME} • ${displayName}`
  ].join(
    '\n'
  );
}

async function buildRegionMenu(
  channel
) {
  let regions = [];

  try {
    regions =
      await getVoiceRegions();
  } catch (error) {
    logError(
      'BUILD_REGION_MENU',
      error
    );
  }

  const current =
    channel.rtcRegion ||
    'automatic';

  const options = [
    {
      label:
        'Tự động',
      value:
        'automatic',
      emoji:
        '🌐',
      default:
        current ===
        'automatic'
    }
  ];

  for (
    const region
    of regions
  ) {
    if (
      options.length >= 25
    ) {
      break;
    }

    options.push({
      label:
        region.name
          .slice(
            0,
            100
          ),
      value:
        region.id,
      emoji:
        region.optimal
          ? '⚡'
          : '🌐',
      default:
        current ===
        region.id
    });
  }

  return (
    new StringSelectMenuBuilder()
      .setCustomId(
        'room_region'
      )
      .setPlaceholder(
        '🌐 Chọn khu vực'
      )
      .setMinValues(
        1
      )
      .setMaxValues(
        1
      )
      .addOptions(
        options
      )
  );
}

async function buildRoomPanel(
  channel,
  room
) {
  const owner =
    await getRoomOwnerMember(
      room,
      channel.guild
    );

  const generator =
    await getGenerator(
      channel.guild.id
    );

  const state =
    getRoomState(
      channel
    );

  const dashboard =
    buildRoomDashboard(
      channel,
      owner,
      generator
    );

  const embed =
    new EmbedBuilder()
      .setDescription(
        `\`\`\`\n${dashboard}\n\`\`\``
      );

  if (
    owner?.user
  ) {
    embed.setAuthor({
      name:
        safeMemberName(
          owner
        ),
      iconURL:
        owner.displayAvatarURL({
          size: 128
        })
    });
  }

  const firstRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'room_lock'
          )
          .setLabel(
            state.locked
              ? 'Mở'
              : 'Khóa'
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
            'room_hide'
          )
          .setLabel(
            state.hidden
              ? 'Hiện'
              : 'Ẩn'
          )
          .setEmoji(
            state.hidden
              ? '👁️'
              : '🙈'
          )
          .setStyle(
            ButtonStyle.Secondary
          ),
        new ButtonBuilder()
          .setCustomId(
            'room_rename'
          )
          .setLabel(
            'Đổi tên'
          )
          .setEmoji(
            '✏️'
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  const secondRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'room_reset'
          )
          .setLabel(
            'Đặt lại'
          )
          .setEmoji(
            '♻️'
          )
          .setStyle(
            ButtonStyle.Secondary
          ),
        new ButtonBuilder()
          .setCustomId(
            'room_limit'
          )
          .setLabel(
            'Giới hạn'
          )
          .setEmoji(
            '👥'
          )
          .setStyle(
            ButtonStyle.Secondary
          ),
        new ButtonBuilder()
          .setCustomId(
            'room_invite'
          )
          .setLabel(
            'Mời'
          )
          .setEmoji(
            '✉️'
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  const thirdRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'room_transfer'
          )
          .setLabel(
            'Chuyển chủ'
          )
          .setEmoji(
            '👑'
          )
          .setStyle(
            ButtonStyle.Secondary
          ),
        new ButtonBuilder()
          .setCustomId(
            'room_deny'
          )
          .setLabel(
            'Cấm'
          )
          .setEmoji(
            '⛔'
          )
          .setStyle(
            ButtonStyle.Danger
          ),
        new ButtonBuilder()
          .setCustomId(
            'room_kick'
          )
          .setLabel(
            'Đuổi'
          )
          .setEmoji(
            '👢'
          )
          .setStyle(
            ButtonStyle.Danger
          )
      );

  const memberRow =
    new ActionRowBuilder()
      .addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(
            'room_member'
          )
          .setPlaceholder(
            '👤 Chọn thành viên'
          )
          .setMinValues(
            1
          )
          .setMaxValues(
            1
          )
      );

  const regionRow =
    new ActionRowBuilder()
      .addComponents(
        await buildRegionMenu(
          channel
        )
      );

  return {
    embeds: [
      embed
    ],
    components: [
      firstRow,
      secondRow,
      thirdRow,
      memberRow,
      regionRow
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

  for (
    const row
    of message.components || []
  ) {
    for (
      const component
      of row.components || []
    ) {
      const customId =
        component.customId ||
        component.custom_id;

      if (
        customId ===
        'room_lock' ||
        customId ===
        'room_member' ||
        customId ===
        'room_region'
      ) {
        return true;
      }
    }
  }

  return false;
}

async function fetchMessageSafe(
  channel,
  messageId
) {
  if (
    !channel?.messages ||
    !isSnowflake(
      String(messageId)
    )
  ) {
    return null;
  }

  try {
    return await channel.messages.fetch(
      String(messageId)
    );
  } catch {
    return null;
  }
}

async function findRoomPanelMessages(
  channel,
  room
) {
  const found =
    new Map();

  if (
    room?.control_message_id
  ) {
    const stored =
      await fetchMessageSafe(
        channel,
        String(
          room.control_message_id
        )
      );

    if (
      stored &&
      isRoomPanelMessage(
        stored
      )
    ) {
      found.set(
        stored.id,
        stored
      );
    }
  }

  try {
    const messages =
      await channel.messages.fetch({
        limit: 50
      });

    for (
      const message
      of messages.values()
    ) {
      if (
        isRoomPanelMessage(
          message
        )
      ) {
        found.set(
          message.id,
          message
        );
      }
    }
  } catch (error) {
    logError(
      'FIND_ROOM_PANELS',
      error
    );
  }

  return (
    [...found.values()]
      .sort(
        (a, b) =>
          b.createdTimestamp -
          a.createdTimestamp
      )
  );
}

async function refreshRoomPanel(
  channelId,
  {
    forceRebuild = false
  } = {}
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

      const guild =
        client.guilds.cache.get(
          String(
            room.guild_id
          )
        );

      if (!guild) {
        return null;
      }

      let channel =
        guild.channels.cache.get(
          String(
            channelId
          )
        );

      if (!channel) {
        channel =
          await guild.channels.fetch(
            String(
              channelId
            )
          ).catch(
            () => null
          );
      }

      if (
        !channel ||
        channel.type !==
          ChannelType.GuildVoice
      ) {
        await deleteRoomRecord(
          String(
            channelId
          )
        );

        return null;
      }

      const payload =
        await buildRoomPanel(
          channel,
          room
        );

      const panels =
        await findRoomPanelMessages(
          channel,
          room
        );

      let panel =
        panels[0] ||
        null;

      if (
        forceRebuild &&
        panel
      ) {
        try {
          await panel.delete();
        } catch {
        }

        panel = null;
      }

      if (panel) {
        try {
          await panel.edit(
            payload
          );
        } catch (error) {
          logError(
            'EDIT_ROOM_PANEL',
            error
          );

          try {
            await panel.delete();
          } catch {
          }

          panel = null;
        }
      }

      if (!panel) {
        panel =
          await channel.send(
            payload
          );
      }

      await setControlMessage(
        channel.id,
        panel.id
      );

      for (
        const duplicate
        of panels
      ) {
        if (
          duplicate.id ===
          panel.id
        ) {
          continue;
        }

        try {
          await duplicate.delete();
        } catch (error) {
          logError(
            'DELETE_DUPLICATE_PANEL',
            error
          );
        }
      }

      return panel;
    }
  );
}

async function refreshRoomPanelSafe(
  channelId,
  options = {}
) {
  try {
    return await refreshRoomPanel(
      channelId,
      options
    );
  } catch (error) {
    logError(
      'REFRESH_ROOM_PANEL',
      error
    );

    return null;
  }
}

async function deleteManagedRoom(
  channelId,
  reason =
    `${BOT_NAME}: xóa phòng`
) {
  const room =
    await getRoom(
      channelId
    );

  if (!room) {
    return false;
  }

  const guild =
    client.guilds.cache.get(
      String(
        room.guild_id
      )
    );

  clearPendingTransfer(
    String(
      channelId
    )
  );

  clearSelectionsForChannel(
    String(
      room.guild_id
    ),
    String(
      channelId
    )
  );

  if (guild) {
    let channel =
      guild.channels.cache.get(
        String(
          channelId
        )
      );

    if (!channel) {
      channel =
        await guild.channels.fetch(
          String(
            channelId
          )
        ).catch(
          () => null
        );
    }

    if (channel) {
      try {
        await channel.delete(
          reason
        );
      } catch (error) {
        logError(
          'DELETE_ROOM_CHANNEL',
          error
        );

        throw error;
      }
    }
  }

  await deleteRoomRecord(
    String(
      channelId
    )
  );

  return true;
}

function scheduleEmptyRoomCheck(
  channelId,
  delay = 2500
) {
  const timer =
    setTimeout(
      async () => {
        try {
          const room =
            await getRoom(
              channelId
            );

          if (!room) {
            return;
          }

          const guild =
            client.guilds.cache.get(
              String(
                room.guild_id
              )
            );

          if (!guild) {
            return;
          }

          let channel =
            guild.channels.cache.get(
              String(
                channelId
              )
            );

          if (!channel) {
            channel =
              await guild.channels.fetch(
                String(
                  channelId
                )
              ).catch(
                () => null
              );
          }

          if (!channel) {
            await deleteRoomRecord(
              String(
                channelId
              )
            );

            return;
          }

          if (
            channel.type !==
            ChannelType.GuildVoice
          ) {
            return;
          }

          const humans =
            channel.members.filter(
              member =>
                !member.user.bot
            );

          if (
            humans.size > 0
          ) {
            return;
          }

          await deleteManagedRoom(
            channel.id,
            `${BOT_NAME}: phòng trống`
          );
        } catch (error) {
          logError(
            'EMPTY_ROOM_CHECK',
            error
          );
        }
      },
      delay
    );

  timer.unref?.();
}

async function getVoiceRoomParent(
  guild,
  generator
) {
  const categoryId =
    generator?.button_category_id;

  if (
    !isSnowflake(
      String(categoryId)
    )
  ) {
    return null;
  }

  let category =
    guild.channels.cache.get(
      String(
        categoryId
      )
    );

  if (!category) {
    category =
      await guild.channels.fetch(
        String(
          categoryId
        )
      ).catch(
        () => null
      );
  }

  if (
    !category ||
    category.type !==
      ChannelType.GuildCategory
  ) {
    return null;
  }

  return category;
}

async function createTempRoom(
  guild,
  member
) {
  return withCreateLock(
    guild.id,
    member.id,
    async () => {
      const generator =
        await getGenerator(
          guild.id
        );

      if (!generator) {
        throw new Error(
          'Voice HDK chưa được cài đặt trong server này.'
        );
      }

      const category =
        await getVoiceRoomParent(
          guild,
          generator
        );

      if (!category) {
        throw new Error(
          'Danh mục đặt nút không còn tồn tại.'
        );
      }

      const existing =
        await getOwnedRoom(
          guild.id,
          member.id
        );

      if (existing) {
        let existingChannel =
          guild.channels.cache.get(
            String(
              existing.channel_id
            )
          );

        if (!existingChannel) {
          existingChannel =
            await guild.channels.fetch(
              String(
                existing.channel_id
              )
            ).catch(
              () => null
            );
        }

        if (
          existingChannel &&
          existingChannel.type ===
            ChannelType.GuildVoice
        ) {
          return {
            channel:
              existingChannel,
            created:
              false
          };
        }

        await deleteRoomRecord(
          String(
            existing.channel_id
          )
        );
      }

      const botMember =
        await getBotMember(
          guild
        );

      if (!botMember) {
        throw new Error(
          'Không tìm thấy bot trong server.'
        );
      }

      let channel = null;

      try {
        channel =
          await guild.channels.create({
            name:
              `${ROOM_PREFIX}${cleanRoomName(
                safeMemberName(
                  member
                )
              )}`,
            type:
              ChannelType.GuildVoice,
            parent:
              category.id,
            reason:
              `${BOT_NAME}: ${safeMemberName(member)} tạo phòng`,
            permissionOverwrites: [
              {
                id:
                  guild.roles.everyone.id,
                allow: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.Connect
                ]
              },
              {
                id:
                  member.id,
                allow: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.Connect
                ]
              },
              {
                id:
                  botMember.id,
                allow: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.Connect,
                  PermissionsBitField.Flags.SendMessages,
                  PermissionsBitField.Flags.ReadMessageHistory,
                  PermissionsBitField.Flags.ManageChannels,
                  PermissionsBitField.Flags.ManageRoles,
                  PermissionsBitField.Flags.MoveMembers
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
        } catch (error) {
          if (
            error?.code ===
            '23505'
          ) {
            try {
              await channel.delete(
                `${BOT_NAME}: phòng trùng`
              );
            } catch {
            }

            const racedRoom =
              await getOwnedRoom(
                guild.id,
                member.id
              );

            if (racedRoom) {
              const racedChannel =
                guild.channels.cache.get(
                  String(
                    racedRoom.channel_id
                  )
                ) ||
                await guild.channels.fetch(
                  String(
                    racedRoom.channel_id
                  )
                ).catch(
                  () => null
                );

              if (
                racedChannel &&
                racedChannel.type ===
                  ChannelType.GuildVoice
              ) {
                return {
                  channel:
                    racedChannel,
                  created:
                    false
                };
              }
            }
          }

          throw error;
        }

        await ensureBotRoomPermissions(
          channel
        );

        await grantOwnerPermissions(
          channel,
          member.id
        );

        await refreshRoomPanelSafe(
          channel.id
        );

        return {
          channel,
          created:
            true
        };
      } catch (error) {
        if (channel) {
          const saved =
            await getRoom(
              channel.id
            ).catch(
              () => null
            );

          if (!saved) {
            try {
              await channel.delete(
                `${BOT_NAME}: hoàn tác tạo phòng lỗi`
              );
            } catch {
            }
          }
        }

        throw error;
      }
    }
  );
}

async function handleCreateRoomButton(
  interaction
) {
  await safeDeferReply(
    interaction,
    true
  );

  if (
    !interaction.guild
  ) {
    await tempReply(
      interaction,
      '❌ Không tìm thấy server.',
      {
        error: true
      }
    );

    return;
  }

  const generator =
    await getGenerator(
      interaction.guild.id
    );

  if (!generator) {
    await tempReply(
      interaction,
      '❌ Voice HDK chưa được cài đặt trong server này.',
      {
        error: true
      }
    );

    return;
  }

  if (
    String(
      generator.create_channel_id ||
      ''
    ) !==
    interaction.channelId
  ) {
    await tempReply(
      interaction,
      '❌ Nút tạo phòng này không còn thuộc hệ thống Voice HDK hiện tại.',
      {
        error: true
      }
    );

    return;
  }

  const cooldown =
    useCooldown(
      interaction.user.id,
      'create_room',
      3000
    );

  if (cooldown) {
    await tempReply(
      interaction,
      '⏳ Vui lòng chờ một chút trước khi tạo phòng.',
      {
        error: true
      }
    );

    return;
  }

  const member =
    await getGuildMember(
      interaction.guild,
      interaction.user.id
    );

  if (!member) {
    await tempReply(
      interaction,
      '❌ Không tìm thấy thông tin thành viên của bạn.',
      {
        error: true
      }
    );

    return;
  }

  try {
    const result =
      await createTempRoom(
        interaction.guild,
        member
      );

    const channel =
      result.channel;

    if (
      member.voice?.channelId
    ) {
      if (
        member.voice.channelId !==
        channel.id
      ) {
        try {
          await member.voice.setChannel(
            channel,
            `${BOT_NAME}: chuyển chủ phòng vào phòng riêng`
          );
        } catch (error) {
          logError(
            'MOVE_OWNER_TO_ROOM',
            error
          );
        }
      }
    }

    if (
      result.created
    ) {
      await tempReply(
        interaction,
        `✅ Đã tạo phòng ${channel}.`
      );
    } else {
      await tempReply(
        interaction,
        `🔊 Bạn đã có phòng ${channel}.`
      );
    }
  } catch (error) {
    logError(
      'CREATE_ROOM_BUTTON',
      error
    );

    await tempReply(
      interaction,
      `❌ Không thể tạo phòng: ${String(
        error?.message ||
        'Lỗi không xác định.'
      ).slice(0, 1000)}`,
      {
        error: true
      }
    );
  }
}

async function getOwnerRoomContext(
  interaction
) {
  if (
    !interaction.guild ||
    !interaction.channel
  ) {
    return {
      ok: false,
      message:
        'Không tìm thấy server hoặc phòng.'
    };
  }

  const room =
    await getRoom(
      interaction.channelId
    );

  if (!room) {
    return {
      ok: false,
      message:
        'Đây không phải phòng Voice HDK đang được quản lý.'
    };
  }

  if (
    String(
      room.guild_id
    ) !==
    interaction.guild.id
  ) {
    return {
      ok: false,
      message:
        'Dữ liệu phòng không khớp với server.'
    };
  }

  if (
    String(
      room.owner_id
    ) !==
    interaction.user.id
  ) {
    return {
      ok: false,
      message:
        'Chỉ chủ phòng hiện tại mới được sử dụng chức năng này.'
    };
  }

  if (
    interaction.channel.type !==
    ChannelType.GuildVoice
  ) {
    return {
      ok: false,
      message:
        'Kênh hiện tại không còn là phòng Voice hợp lệ.'
    };
  }

  return {
    ok: true,
    room,
    channel:
      interaction.channel
  };
}

async function handleMemberSelect(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempFollowUp(
      interaction,
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const targetId =
    interaction.values?.[0];

  if (
    !isSnowflake(
      String(
        targetId
      )
    )
  ) {
    await tempFollowUp(
      interaction,
      '❌ Thành viên được chọn không hợp lệ.',
      {
        error: true
      }
    );

    return;
  }

  if (
    targetId ===
    interaction.user.id
  ) {
    clearSelectedMember(
      interaction.guild.id,
      interaction.channelId,
      interaction.user.id
    );

    await tempFollowUp(
      interaction,
      '❌ Bạn không cần chọn chính mình.',
      {
        error: true
      }
    );

    return;
  }

  const target =
    await getGuildMember(
      interaction.guild,
      targetId
    );

  if (
    !target ||
    target.user.bot
  ) {
    clearSelectedMember(
      interaction.guild.id,
      interaction.channelId,
      interaction.user.id
    );

    await tempFollowUp(
      interaction,
      '❌ Hãy chọn một thành viên hợp lệ trong server.',
      {
        error: true
      }
    );

    return;
  }

  setSelectedMember(
    interaction.guild.id,
    interaction.channelId,
    interaction.user.id,
    target.id
  );
}
async function getRequiredSelectedMember(
  interaction,
  context
) {
  const member =
    await getSelectedMember(
      interaction.guild,
      interaction.channelId,
      interaction.user.id
    );

  if (!member) {
    await tempFollowUp(
      interaction,
      '❌ Hãy chọn thành viên ở menu **👤 Chọn thành viên** trước.',
      {
        error: true
      }
    );

    return null;
  }

  if (
    member.id ===
    String(
      context.room.owner_id
    )
  ) {
    clearSelectedMember(
      interaction.guild.id,
      interaction.channelId,
      interaction.user.id
    );

    await tempFollowUp(
      interaction,
      '❌ Không thể thực hiện thao tác này với chính chủ phòng.',
      {
        error: true
      }
    );

    return null;
  }

  return member;
}

async function handleRoomLock(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempFollowUp(
      interaction,
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const cooldown =
    useCooldown(
      interaction.user.id,
      `lock:${interaction.channelId}`
    );

  if (cooldown) {
    await tempFollowUp(
      interaction,
      '⏳ Thao tác quá nhanh, vui lòng thử lại.',
      {
        error: true
      }
    );

    return;
  }

  try {
    const state =
      getRoomState(
        context.channel
      );

    const nextLocked =
      !state.locked;

    await setRoomLocked(
      context.channel,
      nextLocked
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    await sendActionLog(
      interaction.guild,
      nextLocked
        ? '🔒'
        : '🔓',
      interaction.member,
      nextLocked
        ? `Khóa phòng ${context.channel.name}`
        : `Mở phòng ${context.channel.name}`
    );

    await tempFollowUp(
      interaction,
      nextLocked
        ? '🔒 Đã khóa phòng.'
        : '🔓 Đã mở phòng.'
    );
  } catch (error) {
    logError(
      'ROOM_LOCK',
      error
    );

    await tempFollowUp(
      interaction,
      '❌ Không thể thay đổi trạng thái khóa phòng.',
      {
        error: true
      }
    );
  }
}

async function handleRoomHide(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempFollowUp(
      interaction,
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const cooldown =
    useCooldown(
      interaction.user.id,
      `hide:${interaction.channelId}`
    );

  if (cooldown) {
    await tempFollowUp(
      interaction,
      '⏳ Thao tác quá nhanh, vui lòng thử lại.',
      {
        error: true
      }
    );

    return;
  }

  try {
    const state =
      getRoomState(
        context.channel
      );

    const nextHidden =
      !state.hidden;

    await setRoomHidden(
      context.channel,
      nextHidden
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    await sendActionLog(
      interaction.guild,
      nextHidden
        ? '🙈'
        : '👁️',
      interaction.member,
      nextHidden
        ? `Ẩn phòng ${context.channel.name}`
        : `Hiện phòng ${context.channel.name}`
    );

    await tempFollowUp(
      interaction,
      nextHidden
        ? '🙈 Đã ẩn phòng.'
        : '👁️ Đã hiện phòng.'
    );
  } catch (error) {
    logError(
      'ROOM_HIDE',
      error
    );

    await tempFollowUp(
      interaction,
      '❌ Không thể thay đổi trạng thái hiển thị của phòng.',
      {
        error: true
      }
    );
  }
}

async function handleRenameButton(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempReply(
      interaction,
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const modal =
    new ModalBuilder()
      .setCustomId(
        'room_rename_modal'
      )
      .setTitle(
        'Đổi tên phòng'
      );

  const input =
    new TextInputBuilder()
      .setCustomId(
        'room_name'
      )
      .setLabel(
        'Tên phòng mới'
      )
      .setPlaceholder(
        'Ví dụ: Gaming'
      )
      .setStyle(
        TextInputStyle.Short
      )
      .setMinLength(
        1
      )
      .setMaxLength(
        80
      )
      .setRequired(
        true
      )
      .setValue(
        cleanRoomName(
          context.channel.name
        )
      );

  modal.addComponents(
    new ActionRowBuilder()
      .addComponents(
        input
      )
  );

  await interaction.showModal(
    modal
  );
}

async function handleRenameModal(
  interaction
) {
  await safeDeferReply(
    interaction,
    true
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempReply(
      interaction,
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const cooldown =
    useCooldown(
      interaction.user.id,
      `rename:${interaction.channelId}`,
      5000
    );

  if (cooldown) {
    await tempReply(
      interaction,
      '⏳ Vui lòng chờ một chút trước khi đổi tên tiếp.',
      {
        error: true
      }
    );

    return;
  }

  const requestedName =
    cleanRoomName(
      interaction.fields.getTextInputValue(
        'room_name'
      )
    );

  const finalName =
    `${ROOM_PREFIX}${requestedName}`
      .slice(
        0,
        100
      );

  try {
    await context.channel.setName(
      finalName,
      `${BOT_NAME}: chủ phòng đổi tên`
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    await sendActionLog(
      interaction.guild,
      '✏️',
      interaction.member,
      `Đổi tên phòng thành ${finalName}`
    );

    await tempReply(
      interaction,
      `✅ Đã đổi tên phòng thành **${finalName}**.`
    );
  } catch (error) {
    logError(
      'ROOM_RENAME',
      error
    );

    await tempReply(
      interaction,
      '❌ Không thể đổi tên phòng lúc này.',
      {
        error: true
      }
    );
  }
}

async function handleLimitButton(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempReply(
      interaction,
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const modal =
    new ModalBuilder()
      .setCustomId(
        'room_limit_modal'
      )
      .setTitle(
        'Giới hạn thành viên'
      );

  const input =
    new TextInputBuilder()
      .setCustomId(
        'room_limit_value'
      )
      .setLabel(
        'Số người tối đa (0 = không giới hạn)'
      )
      .setPlaceholder(
        'Ví dụ: 5'
      )
      .setStyle(
        TextInputStyle.Short
      )
      .setMinLength(
        1
      )
      .setMaxLength(
        2
      )
      .setRequired(
        true
      )
      .setValue(
        String(
          context.channel.userLimit ||
          0
        )
      );

  modal.addComponents(
    new ActionRowBuilder()
      .addComponents(
        input
      )
  );

  await interaction.showModal(
    modal
  );
}

async function handleLimitModal(
  interaction
) {
  await safeDeferReply(
    interaction,
    true
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempReply(
      interaction,
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const raw =
    interaction.fields
      .getTextInputValue(
        'room_limit_value'
      )
      .trim();

  if (
    !/^\d{1,2}$/.test(
      raw
    )
  ) {
    await tempReply(
      interaction,
      '❌ Giới hạn phải là số từ **0 đến 99**.',
      {
        error: true
      }
    );

    return;
  }

  const limit =
    Number(raw);

  if (
    !Number.isInteger(
      limit
    ) ||
    limit < 0 ||
    limit > 99
  ) {
    await tempReply(
      interaction,
      '❌ Giới hạn phải nằm trong khoảng **0 đến 99**.',
      {
        error: true
      }
    );

    return;
  }

  try {
    await context.channel.setUserLimit(
      limit,
      `${BOT_NAME}: chủ phòng đổi giới hạn`
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    await sendActionLog(
      interaction.guild,
      '👥',
      interaction.member,
      limit === 0
        ? `Bỏ giới hạn phòng ${context.channel.name}`
        : `Giới hạn phòng ${context.channel.name}: ${limit} người`
    );

    await tempReply(
      interaction,
      limit === 0
        ? '👥 Đã bỏ giới hạn thành viên.'
        : `👥 Đã đặt giới hạn **${limit} người**.`
    );
  } catch (error) {
    logError(
      'ROOM_LIMIT',
      error
    );

    await tempReply(
      interaction,
      '❌ Không thể thay đổi giới hạn phòng.',
      {
        error: true
      }
    );
  }
}

async function handleInviteMember(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempFollowUp(
      interaction,
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const member =
    await getRequiredSelectedMember(
      interaction,
      context
    );

  if (!member) {
    return;
  }

  try {
    await inviteMember(
      context.channel,
      member
    );

    clearSelectedMember(
      interaction.guild.id,
      interaction.channelId,
      interaction.user.id
    );

    await sendActionLog(
      interaction.guild,
      '✉️',
      interaction.member,
      `Mời ${safeMemberName(member)} vào phòng ${context.channel.name}`
    );

    await tempFollowUp(
      interaction,
      `✉️ Đã cấp quyền vào phòng cho **${safeMemberName(member)}**.`
    );
  } catch (error) {
    logError(
      'ROOM_INVITE',
      error
    );

    await tempFollowUp(
      interaction,
      '❌ Không thể mời thành viên vào phòng.',
      {
        error: true
      }
    );
  }
}

async function handleDenyMember(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempFollowUp(
      interaction,
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const member =
    await getRequiredSelectedMember(
      interaction,
      context
    );

  if (!member) {
    return;
  }

  try {
    await denyMember(
      context.channel,
      member
    );

    clearSelectedMember(
      interaction.guild.id,
      interaction.channelId,
      interaction.user.id
    );

    await sendActionLog(
      interaction.guild,
      '⛔',
      interaction.member,
      `Cấm ${safeMemberName(member)} khỏi phòng ${context.channel.name}`
    );

    await tempFollowUp(
      interaction,
      `⛔ Đã cấm **${safeMemberName(member)}** khỏi phòng.`
    );
  } catch (error) {
    logError(
      'ROOM_DENY',
      error
    );

    await tempFollowUp(
      interaction,
      '❌ Không thể cấm thành viên khỏi phòng.',
      {
        error: true
      }
    );
  }
}

async function handleKickMember(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempFollowUp(
      interaction,
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const member =
    await getRequiredSelectedMember(
      interaction,
      context
    );

  if (!member) {
    return;
  }

  if (
    member.voice?.channelId !==
    context.channel.id
  ) {
    await tempFollowUp(
      interaction,
      '❌ Thành viên được chọn không còn ở trong phòng này.',
      {
        error: true
      }
    );

    return;
  }

  try {
    await kickMember(
      context.channel,
      member
    );

    clearSelectedMember(
      interaction.guild.id,
      interaction.channelId,
      interaction.user.id
    );

    await sendActionLog(
      interaction.guild,
      '👢',
      interaction.member,
      `Đuổi ${safeMemberName(member)} khỏi phòng ${context.channel.name}`
    );

    await tempFollowUp(
      interaction,
      `👢 Đã đuổi **${safeMemberName(member)}** khỏi phòng.`
    );
  } catch (error) {
    logError(
      'ROOM_KICK',
      error
    );

    await tempFollowUp(
      interaction,
      `❌ ${String(
        error?.message ||
        'Không thể đuổi thành viên.'
      ).slice(0, 1000)}`,
      {
        error: true
      }
    );
  }
}

async function handleRegionSelect(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempFollowUp(
      interaction,
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const cooldown =
    useCooldown(
      interaction.user.id,
      `region:${interaction.channelId}`,
      3000
    );

  if (cooldown) {
    await tempFollowUp(
      interaction,
      '⏳ Vui lòng chờ một chút trước khi đổi khu vực tiếp.',
      {
        error: true
      }
    );

    return;
  }

  const requested =
    interaction.values?.[0];

  try {
    let regionId = null;
    let regionName =
      'Tự động';

    if (
      requested &&
      requested !==
        'automatic'
    ) {
      const region =
        await validateRegion(
          requested
        );

      if (!region) {
        await tempFollowUp(
          interaction,
          '❌ Khu vực này không còn khả dụng trên Discord.',
          {
            error: true
          }
        );

        await refreshRoomPanelSafe(
          context.channel.id
        );

        return;
      }

      regionId =
        region.id;

      regionName =
        region.name;
    }

    await context.channel.setRTCRegion(
      regionId,
      `${BOT_NAME}: chủ phòng đổi khu vực`
    );

    let verifiedChannel =
      await interaction.guild.channels.fetch(
        context.channel.id
      ).catch(
        () => null
      );

    if (!verifiedChannel) {
      verifiedChannel =
        context.channel;
    }

    const actual =
      verifiedChannel.rtcRegion ||
      null;

    if (
      actual !==
      regionId
    ) {
      throw new Error(
        'Discord chưa xác nhận khu vực vừa chọn.'
      );
    }

    await refreshRoomPanelSafe(
      context.channel.id
    );

    await sendActionLog(
      interaction.guild,
      '🌐',
      interaction.member,
      `Đổi khu vực phòng ${context.channel.name}: ${regionName}`
    );

    await tempFollowUp(
      interaction,
      `🌐 Đã đổi khu vực thành **${regionName}**.`
    );
  } catch (error) {
    logError(
      'ROOM_REGION',
      error
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    await tempFollowUp(
      interaction,
      '❌ Không thể đổi khu vực Voice lúc này.',
      {
        error: true
      }
    );
  }
}

function buildResetConfirmPanel() {
  const embed =
    new EmbedBuilder()
      .setTitle(
        '♻️ ĐẶT LẠI PHÒNG'
      )
      .setDescription(
        [
          'Phòng sẽ được đưa về trạng thái mặc định:',
          '',
          '🔓 Mở phòng',
          '👁️ Hiển thị công khai',
          '👥 Không giới hạn thành viên',
          '🌐 Khu vực tự động',
          '🧹 Xóa quyền Mời/Cấm riêng của thành viên',
          '',
          '**Chủ phòng và phòng hiện tại vẫn được giữ nguyên.**'
        ].join(
          '\n'
        )
      );

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'room_reset_confirm'
          )
          .setLabel(
            'Đặt lại'
          )
          .setEmoji(
            '♻️'
          )
          .setStyle(
            ButtonStyle.Danger
          ),
        new ButtonBuilder()
          .setCustomId(
            'room_reset_cancel'
          )
          .setLabel(
            'Hủy'
          )
          .setEmoji(
            '✖️'
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  return {
    embeds: [
      embed
    ],
    components: [
      row
    ]
  };
}

async function handleResetButton(
  interaction
) {
  await safeDeferReply(
    interaction,
    true
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempReply(
      interaction,
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  await interaction.editReply(
    buildResetConfirmPanel()
  );
}

async function handleResetConfirm(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempFollowUp(
      interaction,
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const cooldown =
    useCooldown(
      interaction.user.id,
      `reset:${interaction.channelId}`,
      5000
    );

  if (cooldown) {
    await tempFollowUp(
      interaction,
      '⏳ Vui lòng chờ trước khi đặt lại phòng lần nữa.',
      {
        error: true
      }
    );

    return;
  }

  try {
    await resetRoom(
      context.channel,
      String(
        context.room.owner_id
      )
    );

    clearSelectedMember(
      interaction.guild.id,
      interaction.channelId,
      interaction.user.id
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    await sendActionLog(
      interaction.guild,
      '♻️',
      interaction.member,
      `Đặt lại phòng ${context.channel.name}`
    );

    try {
      await interaction.editReply({
        content:
          '♻️ Đã đặt lại phòng về trạng thái mặc định.',
        embeds: [],
        components: []
      });
    } catch (error) {
      logError(
        'RESET_CONFIRM_REPLY',
        error
      );
    }

    deleteReplyLater(
      interaction,
      SUCCESS_DELETE_MS
    );
  } catch (error) {
    logError(
      'ROOM_RESET',
      error
    );

    try {
      await interaction.editReply({
        content:
          '❌ Không thể đặt lại phòng lúc này.',
        embeds: [],
        components: []
      });

      deleteReplyLater(
        interaction,
        ERROR_DELETE_MS
      );
    } catch {
    }
  }
}

async function handleResetCancel(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  try {
    await interaction.editReply({
      content:
        '✖️ Đã hủy đặt lại phòng.',
      embeds: [],
      components: []
    });
  } catch (error) {
    logError(
      'RESET_CANCEL',
      error
    );
  }

  deleteReplyLater(
    interaction,
    SUCCESS_DELETE_MS
  );
}
async function sendActionLog(
  guild,
  emoji,
  actor,
  action
) {
  try {
    if (!guild) {
      return false;
    }

    const generator =
      await getGenerator(
        guild.id
      );

    if (
      !generator?.action_log_channel_id
    ) {
      return false;
    }

    let channel =
      guild.channels.cache.get(
        String(
          generator.action_log_channel_id
        )
      );

    if (!channel) {
      channel =
        await guild.channels.fetch(
          String(
            generator.action_log_channel_id
          )
        ).catch(
          () => null
        );
    }

    if (
      !channel ||
      !channel.isTextBased()
    ) {
      return false;
    }

    let actorName =
      BOT_NAME;

    if (actor) {
      if (
        typeof actor === 'string'
      ) {
        actorName =
          cleanDisplayName(
            actor
          ) ||
          BOT_NAME;
      } else {
        actorName =
          safeMemberName(
            actor
          );
      }
    }

    const cleanAction =
      String(
        action || ''
      )
        .replace(
          /[\r\n]+/g,
          ' '
        )
        .trim()
        .slice(
          0,
          1600
        );

    await channel.send({
      content:
        `${emoji} ${actorName} » ${cleanAction} • ${vietnamTime()}`
    });

    return true;
  } catch (error) {
    logError(
      'ACTION_LOG',
      error
    );

    return false;
  }
}

function transferMessageComponents(
  channelId,
  ownerId,
  targetId
) {
  return [
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `transfer_accept:${channelId}:${ownerId}:${targetId}`
          )
          .setLabel(
            'Đồng ý'
          )
          .setEmoji(
            '👑'
          )
          .setStyle(
            ButtonStyle.Success
          ),
        new ButtonBuilder()
          .setCustomId(
            `transfer_decline:${channelId}:${ownerId}:${targetId}`
          )
          .setLabel(
            'Từ chối'
          )
          .setEmoji(
            '✖️'
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      )
  ];
}

async function finishTransferMessage(
  transfer,
  content
) {
  if (
    !transfer?.message
  ) {
    return;
  }

  try {
    await transfer.message.edit({
      content,
      embeds: [],
      components: []
    });

    deleteMessageLater(
      transfer.message,
      SUCCESS_DELETE_MS
    );
  } catch (error) {
    logError(
      'TRANSFER_FINISH_MESSAGE',
      error
    );
  }
}

async function expireTransfer(
  channelId
) {
  const transfer =
    pendingTransfers.get(
      transferKey(
        channelId
      )
    );

  if (!transfer) {
    return;
  }

  if (
    transfer.expiresAt >
    Date.now()
  ) {
    return;
  }

  pendingTransfers.delete(
    transferKey(
      channelId
    )
  );

  let targetName =
    transfer.targetName ||
    'Thành viên';

  try {
    const guild =
      client.guilds.cache.get(
        transfer.guildId
      );

    const target =
      guild
        ? await getGuildMember(
            guild,
            transfer.targetId
          )
        : null;

    if (target) {
      targetName =
        safeMemberName(
          target
        );
    }
  } catch {
  }

  await finishTransferMessage(
    transfer,
    `⌛ ${targetName} đã từ chối do không phản hồi trong 60 giây.`
  );
}

async function handleTransferButton(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempFollowUp(
      interaction,
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const existingTransfer =
    getPendingTransfer(
      context.channel.id
    );

  if (existingTransfer) {
    await tempFollowUp(
      interaction,
      '⏳ Phòng đang có một yêu cầu chuyển chủ chờ phản hồi.',
      {
        error: true
      }
    );

    return;
  }

  const target =
    await getRequiredSelectedMember(
      interaction,
      context
    );

  if (!target) {
    return;
  }

  if (
    target.voice?.channelId !==
    context.channel.id
  ) {
    await tempFollowUp(
      interaction,
      '❌ Người nhận quyền chủ phải đang ở trong phòng này.',
      {
        error: true
      }
    );

    return;
  }

  const expiresAt =
    Date.now() +
    TRANSFER_TIMEOUT_MS;

  try {
    const owner =
      await getGuildMember(
        interaction.guild,
        interaction.user.id
      );

    const ownerName =
      owner
        ? safeMemberName(
            owner
          )
        : cleanDisplayName(
            interaction.user.globalName ||
            interaction.user.username
          );

    const targetName =
      safeMemberName(
        target
      );

    const message =
      await context.channel.send({
        content:
          `👑 ${ownerName} muốn chuyển quyền chủ phòng cho <@${target.id}>\n` +
          `⏳ Hết hạn ${relativeTimestamp(expiresAt)}`,
        components:
          transferMessageComponents(
            context.channel.id,
            interaction.user.id,
            target.id
          ),
        allowedMentions: {
          users: [
            target.id
          ]
        }
      });

    const transfer = {
      guildId:
        interaction.guild.id,
      channelId:
        context.channel.id,
      ownerId:
        interaction.user.id,
      targetId:
        target.id,
      targetName,
      expiresAt,
      message,
      timer:
        null
    };

    const timer =
      setTimeout(
        () => {
          expireTransfer(
            context.channel.id
          ).catch(
            error => {
              logError(
                'TRANSFER_TIMEOUT',
                error
              );
            }
          );
        },
        TRANSFER_TIMEOUT_MS +
        250
      );

    timer.unref?.();

    transfer.timer =
      timer;

    pendingTransfers.set(
      transferKey(
        context.channel.id
      ),
      transfer
    );

    clearSelectedMember(
      interaction.guild.id,
      interaction.channelId,
      interaction.user.id
    );

    await sendActionLog(
      interaction.guild,
      '👑',
      interaction.member,
      `Gửi yêu cầu chuyển chủ phòng ${context.channel.name} cho ${targetName}`
    );
  } catch (error) {
    logError(
      'TRANSFER_REQUEST',
      error
    );

    await tempFollowUp(
      interaction,
      '❌ Không thể gửi yêu cầu chuyển chủ.',
      {
        error: true
      }
    );
  }
}

function parseTransferCustomId(
  customId
) {
  const parts =
    String(
      customId || ''
    ).split(
      ':'
    );

  if (
    parts.length !== 4
  ) {
    return null;
  }

  const [
    action,
    channelId,
    ownerId,
    targetId
  ] = parts;

  if (
    action !==
      'transfer_accept' &&
    action !==
      'transfer_decline'
  ) {
    return null;
  }

  if (
    !isSnowflake(
      channelId
    ) ||
    !isSnowflake(
      ownerId
    ) ||
    !isSnowflake(
      targetId
    )
  ) {
    return null;
  }

  return {
    action,
    channelId,
    ownerId,
    targetId
  };
}

async function handleTransferDecision(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const parsed =
    parseTransferCustomId(
      interaction.customId
    );

  if (
    !parsed ||
    !interaction.guild
  ) {
    await tempFollowUp(
      interaction,
      '❌ Yêu cầu chuyển chủ không hợp lệ.',
      {
        error: true
      }
    );

    return;
  }

  const transfer =
    getPendingTransfer(
      parsed.channelId
    );

  if (
    !transfer ||
    transfer.ownerId !==
      parsed.ownerId ||
    transfer.targetId !==
      parsed.targetId
  ) {
    await tempFollowUp(
      interaction,
      '⌛ Yêu cầu chuyển chủ này đã hết hạn hoặc không còn hiệu lực.',
      {
        error: true
      }
    );

    return;
  }

  if (
    interaction.user.id !==
    transfer.targetId
  ) {
    await tempFollowUp(
      interaction,
      '❌ Chỉ thành viên được mời nhận quyền chủ mới có thể phản hồi.',
      {
        error: true
      }
    );

    return;
  }

  if (
    parsed.action ===
    'transfer_decline'
  ) {
    clearPendingTransfer(
      parsed.channelId
    );

    const target =
      await getGuildMember(
        interaction.guild,
        transfer.targetId
      );

    const targetName =
      target
        ? safeMemberName(
            target
          )
        : transfer.targetName;

    await finishTransferMessage(
      transfer,
      `✖️ ${targetName} đã từ chối nhận quyền chủ phòng.`
    );

    await sendActionLog(
      interaction.guild,
      '✖️',
      target ||
      targetName,
      'Từ chối yêu cầu nhận quyền chủ phòng'
    );

    return;
  }

  const room =
    await getRoom(
      parsed.channelId
    );

  if (!room) {
    clearPendingTransfer(
      parsed.channelId
    );

    await finishTransferMessage(
      transfer,
      '❌ Phòng không còn tồn tại.'
    );

    return;
  }

  if (
    String(
      room.owner_id
    ) !==
    transfer.ownerId
  ) {
    clearPendingTransfer(
      parsed.channelId
    );

    await finishTransferMessage(
      transfer,
      '❌ Chủ phòng đã thay đổi. Yêu cầu chuyển chủ cũ không còn hiệu lực.'
    );

    return;
  }

  let channel =
    interaction.guild.channels.cache.get(
      parsed.channelId
    );

  if (!channel) {
    channel =
      await interaction.guild.channels.fetch(
        parsed.channelId
      ).catch(
        () => null
      );
  }

  if (
    !channel ||
    channel.type !==
      ChannelType.GuildVoice
  ) {
    clearPendingTransfer(
      parsed.channelId
    );

    await finishTransferMessage(
      transfer,
      '❌ Phòng không còn tồn tại.'
    );

    return;
  }

  const target =
    await getGuildMember(
      interaction.guild,
      transfer.targetId
    );

  if (
    !target ||
    target.voice?.channelId !==
      channel.id
  ) {
    await tempFollowUp(
      interaction,
      '❌ Bạn phải còn ở trong phòng để nhận quyền chủ.',
      {
        error: true
      }
    );

    return;
  }

  const oldOwner =
    await getGuildMember(
      interaction.guild,
      transfer.ownerId
    );

  try {
    const conflictingRoom =
      await getOwnedRoom(
        interaction.guild.id,
        target.id
      );

    if (
      conflictingRoom &&
      String(
        conflictingRoom.channel_id
      ) !==
      channel.id
    ) {
      let conflictChannel =
        interaction.guild.channels.cache.get(
          String(
            conflictingRoom.channel_id
          )
        );

      if (!conflictChannel) {
        conflictChannel =
          await interaction.guild.channels.fetch(
            String(
              conflictingRoom.channel_id
            )
          ).catch(
            () => null
          );
      }

      if (conflictChannel) {
        await tempFollowUp(
          interaction,
          '❌ Bạn đang sở hữu một phòng Voice HDK khác nên chưa thể nhận phòng này.',
          {
            error: true
          }
        );

        return;
      }

      await deleteRoomRecord(
        String(
          conflictingRoom.channel_id
        )
      );
    }

    await grantOwnerPermissions(
      channel,
      target.id
    );

    const dbClient =
      await pool.connect();

    try {
      await dbClient.query(
        'BEGIN'
      );

      const locked =
        await dbClient.query(
          `
            SELECT owner_id
            FROM rooms
            WHERE channel_id = $1
            FOR UPDATE
          `,
          [
            channel.id
          ]
        );

      if (
        !locked.rows[0] ||
        String(
          locked.rows[0].owner_id
        ) !==
        transfer.ownerId
      ) {
        throw new Error(
          'Chủ phòng đã thay đổi trước khi xác nhận.'
        );
      }

      await dbClient.query(
        `
          UPDATE rooms
          SET owner_id = $1
          WHERE channel_id = $2
        `,
        [
          target.id,
          channel.id
        ]
      );

      await dbClient.query(
        'COMMIT'
      );
    } catch (error) {
      await dbClient.query(
        'ROLLBACK'
      ).catch(
        () => {}
      );

      throw error;
    } finally {
      dbClient.release();
    }

    const oldOwnerOverwrite =
      channel.permissionOverwrites.cache.get(
        transfer.ownerId
      );

    if (
      oldOwnerOverwrite &&
      oldOwnerOverwrite.type ===
        PermissionOverwriteType.Member
    ) {
      await safeDeleteOverwrite(
        channel,
        transfer.ownerId,
        `${BOT_NAME}: thu hồi quyền chủ phòng cũ`
      );
    }

    clearPendingTransfer(
      channel.id
    );

    clearSelectionsForChannel(
      interaction.guild.id,
      channel.id
    );

    await refreshRoomPanelSafe(
      channel.id
    );

    const targetName =
      safeMemberName(
        target
      );

    await finishTransferMessage(
      transfer,
      `👑 ${targetName} đã trở thành chủ phòng mới.`
    );

    await sendActionLog(
      interaction.guild,
      '👑',
      oldOwner ||
      transfer.ownerId,
      `Chuyển chủ phòng ${channel.name} cho ${targetName}`
    );
  } catch (error) {
    logError(
      'TRANSFER_ACCEPT',
      error
    );

    const currentRoom =
      await getRoom(
        channel.id
      ).catch(
        () => null
      );

    if (
      !currentRoom ||
      String(
        currentRoom.owner_id
      ) !==
      target.id
    ) {
      await safeDeleteOverwrite(
        channel,
        target.id,
        `${BOT_NAME}: hoàn tác quyền chuyển chủ lỗi`
      ).catch(
        () => {}
      );
    }

    await tempFollowUp(
      interaction,
      `❌ Không thể chuyển chủ: ${String(
        error?.message ||
        'Lỗi không xác định.'
      ).slice(0, 1000)}`,
      {
        error: true
      }
    );
  }
}

async function claimRoom(
  channel,
  member
) {
  const room =
    await getRoom(
      channel.id
    );

  if (!room) {
    throw new Error(
      'Phòng không còn được Voice HDK quản lý.'
    );
  }

  if (
    String(
      room.owner_id
    ) ===
    member.id
  ) {
    throw new Error(
      'Bạn đã là chủ phòng.'
    );
  }

  if (
    member.voice?.channelId !==
    channel.id
  ) {
    throw new Error(
      'Bạn phải đang ở trong phòng để nhận quyền chủ.'
    );
  }

  const currentOwner =
    await getGuildMember(
      channel.guild,
      String(
        room.owner_id
      )
    );

  if (
    currentOwner?.voice?.channelId ===
    channel.id
  ) {
    throw new Error(
      'Chủ phòng hiện tại vẫn đang ở trong phòng.'
    );
  }

  const owned =
    await getOwnedRoom(
      channel.guild.id,
      member.id
    );

  if (
    owned &&
    String(
      owned.channel_id
    ) !==
    channel.id
  ) {
    let ownedChannel =
      channel.guild.channels.cache.get(
        String(
          owned.channel_id
        )
      );

    if (!ownedChannel) {
      ownedChannel =
        await channel.guild.channels.fetch(
          String(
            owned.channel_id
          )
        ).catch(
          () => null
        );
    }

    if (ownedChannel) {
      throw new Error(
        'Bạn đang sở hữu một phòng Voice HDK khác.'
      );
    }

    await deleteRoomRecord(
      String(
        owned.channel_id
      )
    );
  }

  await grantOwnerPermissions(
    channel,
    member.id
  );

  const dbClient =
    await pool.connect();

  try {
    await dbClient.query(
      'BEGIN'
    );

    const locked =
      await dbClient.query(
        `
          SELECT owner_id
          FROM rooms
          WHERE channel_id = $1
          FOR UPDATE
        `,
        [
          channel.id
        ]
      );

    if (!locked.rows[0]) {
      throw new Error(
        'Phòng không còn trong Database.'
      );
    }

    const lockedOwnerId =
      String(
        locked.rows[0].owner_id
      );

    const lockedOwner =
      await getGuildMember(
        channel.guild,
        lockedOwnerId
      );

    if (
      lockedOwner?.voice?.channelId ===
      channel.id
    ) {
      throw new Error(
        'Chủ phòng đã quay lại phòng.'
      );
    }

    await dbClient.query(
      `
        UPDATE rooms
        SET owner_id = $1
        WHERE channel_id = $2
      `,
      [
        member.id,
        channel.id
      ]
    );

    await dbClient.query(
      'COMMIT'
    );

    if (
      lockedOwnerId !==
      member.id
    ) {
      await safeDeleteOverwrite(
        channel,
        lockedOwnerId,
        `${BOT_NAME}: thu hồi quyền chủ phòng cũ`
      );
    }

    clearPendingTransfer(
      channel.id
    );

    clearSelectionsForChannel(
      channel.guild.id,
      channel.id
    );

    await refreshRoomPanelSafe(
      channel.id
    );

    return true;
  } catch (error) {
    await dbClient.query(
      'ROLLBACK'
    ).catch(
      () => {}
    );

    const current =
      await getRoom(
        channel.id
      ).catch(
        () => null
      );

    if (
      !current ||
      String(
        current.owner_id
      ) !==
      member.id
    ) {
      await safeDeleteOverwrite(
        channel,
        member.id,
        `${BOT_NAME}: hoàn tác quyền claim lỗi`
      ).catch(
        () => {}
      );
    }

    throw error;
  } finally {
    dbClient.release();
  }
}

async function sendChatLog(
  guild,
  payload
) {
  try {
    const generator =
      await getGenerator(
        guild.id
      );

    if (
      !generator?.chat_log_channel_id
    ) {
      return null;
    }

    let channel =
      guild.channels.cache.get(
        String(
          generator.chat_log_channel_id
        )
      );

    if (!channel) {
      channel =
        await guild.channels.fetch(
          String(
            generator.chat_log_channel_id
          )
        ).catch(
          () => null
        );
    }

    if (
      !channel ||
      !channel.isTextBased()
    ) {
      return null;
    }

    return await channel.send(
      payload
    );
  } catch (error) {
    logError(
      'CHAT_LOG_SEND',
      error
    );

    return null;
  }
}

function sanitizeLogText(
  value,
  maxLength = 1400
) {
  const text =
    String(
      value || ''
    )
      .replace(
        /\u0000/g,
        ''
      )
      .trim();

  if (!text) {
    return '';
  }

  if (
    text.length <=
    maxLength
  ) {
    return text;
  }

  return (
    text.slice(
      0,
      maxLength - 1
    ) +
    '…'
  );
}

function quoteLogText(
  value
) {
  return sanitizeLogText(
    value
  )
    .replace(
      /\\/g,
      '\\\\'
    )
    .replace(
      /"/g,
      '\\"'
    )
    .replace(
      /\r?\n/g,
      ' ↵ '
    );
}

function extractLinks(
  content
) {
  const matches =
    String(
      content || ''
    ).match(
      /https?:\/\/[^\s<>"']+/gi
    ) || [];

  return [
    ...new Set(
      matches
    )
  ].slice(
    0,
    10
  );
}

function safeAttachmentName(
  attachment
) {
  return sanitizeLogText(
    attachment?.name ||
    'tep-dinh-kem',
    120
  );
}

async function downloadAttachmentForLog(
  attachment
) {
  const maxBytes =
    8 * 1024 * 1024;

  if (
    Number(
      attachment.size || 0
    ) >
    maxBytes
  ) {
    return {
      ok: false,
      reason:
        'Tệp quá lớn để sao lưu trực tiếp',
      url:
        attachment.url
    };
  }

  try {
    const response =
      await fetch(
        attachment.url,
        {
          signal:
            AbortSignal.timeout(
              15000
            )
        }
      );

    if (
      !response.ok
    ) {
      throw new Error(
        `HTTP ${response.status}`
      );
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
      return {
        ok: false,
        reason:
          'Tệp quá lớn để sao lưu trực tiếp',
        url:
          attachment.url
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
          'Tệp quá lớn để sao lưu trực tiếp',
        url:
          attachment.url
      };
    }

    return {
      ok: true,
      attachment: {
        attachment:
          buffer,
        name:
          safeAttachmentName(
            attachment
          )
      }
    };
  } catch (error) {
    logError(
      'DOWNLOAD_ATTACHMENT',
      error
    );

    return {
      ok: false,
      reason:
        'Không thể sao lưu tệp',
      url:
        attachment.url
    };
  }
}

async function archiveAttachments(
  message
) {
  const files = [];
  const descriptions = [];

  for (
    const attachment
    of message.attachments.values()
  ) {
    const name =
      safeAttachmentName(
        attachment
      );

    const archived =
      await downloadAttachmentForLog(
        attachment
      );

    if (
      archived.ok
    ) {
      files.push(
        archived.attachment
      );

      descriptions.push(
        name
      );
    } else {
      descriptions.push(
        `${name} ⚠️ ${archived.reason}: ${archived.url}`
      );
    }
  }

  return {
    files,
    descriptions
  };
}

async function handleChatMessageCreate(
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
    !generator?.chat_log_channel_id
  ) {
    return;
  }

  if (
    message.channelId ===
    String(
      generator.chat_log_channel_id
    ) ||
    message.channelId ===
    String(
      generator.action_log_channel_id
    )
  ) {
    return;
  }

  const authorName =
    safeMemberName(
      message.member
    );

  const content =
    sanitizeLogText(
      message.content
    );

  const links =
    extractLinks(
      message.content
    );

  const archived =
    await archiveAttachments(
      message
    );

  const lines = [];

  if (content) {
    lines.push(
      `💬 ${authorName} » "${quoteLogText(content)}"`
    );
  } else {
    lines.push(
      `💬 ${authorName} » Tin nhắn không có nội dung văn bản`
    );
  }

  if (
    links.length
  ) {
    lines.push(
      `🔗 Liên kết: ${links.join(' • ')}`
    );
  }

  if (
    archived.descriptions.length
  ) {
    lines.push(
      `📎 Tệp đính kèm: ${archived.descriptions.join(' • ')}`
    );
  }

  if (
    lines.length === 1 &&
    !archived.files.length
  ) {
    lines[0] +=
      ` • ${vietnamTime(message.createdAt)}`;
  } else {
    lines.push(
      vietnamTime(
        message.createdAt
      )
    );
  }

  const payload = {
    content:
      sanitizeLogText(
        lines.join(
          '\n'
        ),
        1900
      ),
    allowedMentions: {
      parse: []
    }
  };

  if (
    archived.files.length
  ) {
    payload.files =
      archived.files;
  }

  const result =
    await sendChatLog(
      message.guild,
      payload
    );

  if (
    !result &&
    archived.files.length
  ) {
    const fallbackLines =
      [
        ...lines,
        '⚠️ Không thể tải bản sao tệp lên Blog. URL gốc:',
        ...[
          ...message.attachments.values()
        ].map(
          attachment =>
            `${safeAttachmentName(attachment)}: ${attachment.url}`
        )
      ];

    await sendChatLog(
      message.guild,
      {
        content:
          sanitizeLogText(
            fallbackLines.join(
              '\n'
            ),
            1900
          ),
        allowedMentions: {
          parse: []
        }
      }
    );
  }
}

async function handleChatMessageUpdate(
  oldMessage,
  newMessage
) {
  try {
    if (
      oldMessage.partial
    ) {
      await oldMessage.fetch().catch(
        () => null
      );
    }

    if (
      newMessage.partial
    ) {
      await newMessage.fetch().catch(
        () => null
      );
    }
  } catch {
  }

  const message =
    newMessage ||
    oldMessage;

  if (
    !message?.guild ||
    message.author?.bot
  ) {
    return;
  }

  const generator =
    await getGenerator(
      message.guild.id
    );

  if (
    !generator?.chat_log_channel_id ||
    message.channelId ===
      String(
        generator.chat_log_channel_id
      ) ||
    message.channelId ===
      String(
        generator.action_log_channel_id
      )
  ) {
    return;
  }

  const before =
    sanitizeLogText(
      oldMessage?.content
    );

  const after =
    sanitizeLogText(
      newMessage?.content
    );

  if (
    before === after
  ) {
    return;
  }

  const authorName =
    safeMemberName(
      newMessage?.member ||
      oldMessage?.member
    );

  const lines = [
    `✏️ ${authorName} » Đã sửa tin nhắn`,
    `⬅️ Trước: "${quoteLogText(before || '(trống)')}"`,
    `➡️ Sau: "${quoteLogText(after || '(trống)')}"`,
    vietnamTime()
  ];

  await sendChatLog(
    message.guild,
    {
      content:
        sanitizeLogText(
          lines.join(
            '\n'
          ),
          1900
        ),
      allowedMentions: {
        parse: []
      }
    }
  );
}

async function handleChatMessageDelete(
  message
) {
  if (
    !message?.guild ||
    message.author?.bot
  ) {
    return;
  }

  const generator =
    await getGenerator(
      message.guild.id
    );

  if (
    !generator?.chat_log_channel_id ||
    message.channelId ===
      String(
        generator.chat_log_channel_id
      ) ||
    message.channelId ===
      String(
        generator.action_log_channel_id
      )
  ) {
    return;
  }

  const authorName =
    safeMemberName(
      message.member
    );

  const content =
    sanitizeLogText(
      message.content
    );

  const attachmentNames =
    message.attachments
      ? [
          ...message.attachments.values()
        ].map(
          safeAttachmentName
        )
      : [];

  const lines = [
    `🗑️ ${authorName} » Đã xóa tin nhắn`,
    `💬 Nội dung: "${quoteLogText(content || '(không có nội dung lưu trong bộ nhớ đệm)')}"`
  ];

  if (
    attachmentNames.length
  ) {
    lines.push(
      `📎 Tệp: ${attachmentNames.join(' • ')}`
    );
  }

  lines.push(
    vietnamTime()
  );

  await sendChatLog(
    message.guild,
    {
      content:
        sanitizeLogText(
          lines.join(
            '\n'
          ),
          1900
        ),
      allowedMentions: {
        parse: []
      }
    }
  );
}
async function handlePanelCommand(
  interaction
) {
  await safeDeferReply(
    interaction,
    true
  );

  if (
    !interaction.guild
  ) {
    await tempReply(
      interaction,
      '❌ Lệnh này chỉ sử dụng trong server.',
      {
        error: true
      }
    );

    return;
  }

  const member =
    await getGuildMember(
      interaction.guild,
      interaction.user.id
    );

  if (!member) {
    await tempReply(
      interaction,
      '❌ Không tìm thấy thông tin thành viên.',
      {
        error: true
      }
    );

    return;
  }

  let room = null;

  if (
    member.voice?.channelId
  ) {
    room =
      await getRoom(
        member.voice.channelId
      );
  }

  if (!room) {
    room =
      await getOwnedRoom(
        interaction.guild.id,
        interaction.user.id
      );
  }

  if (!room) {
    await tempReply(
      interaction,
      '❌ Bạn chưa có phòng Voice HDK.',
      {
        error: true
      }
    );

    return;
  }

  if (
    String(
      room.owner_id
    ) !==
    interaction.user.id
  ) {
    await tempReply(
      interaction,
      '❌ Bạn không phải chủ phòng hiện tại.',
      {
        error: true
      }
    );

    return;
  }

  let channel =
    interaction.guild.channels.cache.get(
      String(
        room.channel_id
      )
    );

  if (!channel) {
    channel =
      await interaction.guild.channels.fetch(
        String(
          room.channel_id
        )
      ).catch(
        () => null
      );
  }

  if (
    !channel ||
    channel.type !==
      ChannelType.GuildVoice
  ) {
    await deleteRoomRecord(
      String(
        room.channel_id
      )
    );

    await tempReply(
      interaction,
      '❌ Phòng không còn tồn tại. Dữ liệu cũ đã được dọn.',
      {
        error: true
      }
    );

    return;
  }

  const panel =
    await refreshRoomPanelSafe(
      channel.id,
      {
        forceRebuild: true
      }
    );

  if (!panel) {
    await tempReply(
      interaction,
      '❌ Không thể khôi phục bảng điều khiển phòng.',
      {
        error: true
      }
    );

    return;
  }

  await sendActionLog(
    interaction.guild,
    '🛠️',
    interaction.member,
    `Khôi phục bảng điều khiển phòng ${channel.name}`
  );

  await tempReply(
    interaction,
    `✅ Đã khôi phục bảng điều khiển tại ${channel}.`
  );
}

async function handleClaimCommand(
  interaction
) {
  await safeDeferReply(
    interaction,
    true
  );

  if (
    !interaction.guild
  ) {
    await tempReply(
      interaction,
      '❌ Lệnh này chỉ sử dụng trong server.',
      {
        error: true
      }
    );

    return;
  }

  const member =
    await getGuildMember(
      interaction.guild,
      interaction.user.id
    );

  if (
    !member ||
    !member.voice?.channelId
  ) {
    await tempReply(
      interaction,
      '❌ Bạn phải đang ở trong một phòng Voice HDK.',
      {
        error: true
      }
    );

    return;
  }

  const room =
    await getRoom(
      member.voice.channelId
    );

  if (!room) {
    await tempReply(
      interaction,
      '❌ Phòng hiện tại không phải phòng Voice HDK.',
      {
        error: true
      }
    );

    return;
  }

  const channel =
    member.voice.channel;

  try {
    await claimRoom(
      channel,
      member
    );

    await sendActionLog(
      interaction.guild,
      '👑',
      member,
      `Nhận quyền chủ phòng ${channel.name}`
    );

    await tempReply(
      interaction,
      '👑 Bạn đã trở thành chủ phòng mới.'
    );
  } catch (error) {
    logError(
      'CLAIM_ROOM',
      error
    );

    await tempReply(
      interaction,
      `❌ ${String(
        error?.message ||
        'Không thể nhận quyền chủ phòng.'
      ).slice(
        0,
        1000
      )}`,
      {
        error: true
      }
    );
  }
}

async function doctorGuild(
  guild
) {
  const checks = [];

  try {
    await pool.query(
      'SELECT 1'
    );

    checks.push(
      '✅ PostgreSQL: hoạt động'
    );
  } catch {
    checks.push(
      '❌ PostgreSQL: lỗi kết nối'
    );
  }

  if (
    client.isReady()
  ) {
    checks.push(
      `✅ Discord Gateway: ${Math.round(
        client.ws.ping
      )} ms`
    );
  } else {
    checks.push(
      '❌ Discord Gateway: chưa sẵn sàng'
    );
  }

  const generator =
    await getGenerator(
      guild.id
    );

  if (!generator) {
    checks.push(
      '❌ Cài đặt: server chưa chạy /setup'
    );

    return checks;
  }

  checks.push(
    `✅ Cài đặt: ${cleanDisplayName(
      generator.display_name
    ) || 'Đã cấu hình'}`
  );

  const botMember =
    await getBotMember(
      guild
    );

  if (!botMember) {
    checks.push(
      '❌ Bot Member: không thể tải'
    );
  } else {
    const missing =
      missingPermissions(
        botMember.permissions
      );

    if (
      missing.length
    ) {
      checks.push(
        `❌ Quyền Bot: thiếu ${permissionNames(
          missing
        ).join(
          ', '
        )}`
      );
    } else {
      checks.push(
        '✅ Quyền Bot: đủ quyền hệ thống'
      );
    }
  }

  const resources = [
    [
      'Danh mục đặt nút',
      generator.button_category_id,
      ChannelType.GuildCategory
    ],
    [
      'Danh mục Blog',
      generator.blog_category_id,
      ChannelType.GuildCategory
    ],
    [
      'Kênh tạo phòng',
      generator.create_channel_id,
      ChannelType.GuildText
    ],
    [
      'Blog Chat',
      generator.chat_log_channel_id,
      ChannelType.GuildText
    ],
    [
      'Blog Chức năng',
      generator.action_log_channel_id,
      ChannelType.GuildText
    ]
  ];

  for (
    const [
      name,
      id,
      expectedType
    ]
    of resources
  ) {
    if (
      !isSnowflake(
        String(
          id
        )
      )
    ) {
      checks.push(
        `❌ ${name}: chưa có ID`
      );

      continue;
    }

    let channel =
      guild.channels.cache.get(
        String(
          id
        )
      );

    if (!channel) {
      channel =
        await guild.channels.fetch(
          String(
            id
          )
        ).catch(
          () => null
        );
    }

    if (!channel) {
      checks.push(
        `❌ ${name}: không tồn tại`
      );

      continue;
    }

    if (
      channel.type !==
      expectedType
    ) {
      checks.push(
        `❌ ${name}: sai loại kênh`
      );

      continue;
    }

    checks.push(
      `✅ ${name}: hoạt động`
    );
  }

  try {
    const regions =
      await getVoiceRegions(
        true
      );

    checks.push(
      regions.length
        ? `✅ Voice Region: ${regions.length} khu vực khả dụng`
        : '⚠️ Voice Region: Discord trả về danh sách rỗng'
    );
  } catch {
    checks.push(
      '❌ Voice Region: không thể kiểm tra'
    );
  }

  const rooms =
    await getGuildRooms(
      guild.id
    );

  let validRooms = 0;
  let staleRooms = 0;

  for (
    const room
    of rooms
  ) {
    let channel =
      guild.channels.cache.get(
        String(
          room.channel_id
        )
      );

    if (!channel) {
      channel =
        await guild.channels.fetch(
          String(
            room.channel_id
          )
        ).catch(
          () => null
        );
    }

    if (
      channel &&
      channel.type ===
        ChannelType.GuildVoice
    ) {
      validRooms++;
    } else {
      staleRooms++;
    }
  }

  checks.push(
    staleRooms
      ? `⚠️ Phòng: ${validRooms} hợp lệ, ${staleRooms} dữ liệu cũ`
      : `✅ Phòng: ${validRooms} phòng hợp lệ`
  );

  return checks;
}

async function handleDoctorCommand(
  interaction
) {
  await safeDeferReply(
    interaction,
    true
  );

  if (
    !interaction.guild
  ) {
    await tempReply(
      interaction,
      '❌ Lệnh này chỉ sử dụng trong server.',
      {
        error: true
      }
    );

    return;
  }

  if (
    !canManageSetup(
      interaction
    )
  ) {
    await tempReply(
      interaction,
      '❌ Bạn cần quyền **Quản lý Server** để kiểm tra hệ thống.',
      {
        error: true
      }
    );

    return;
  }

  try {
    const checks =
      await doctorGuild(
        interaction.guild
      );

    const embed =
      new EmbedBuilder()
        .setTitle(
          '🩺 KIỂM TRA VOICE HDK'
        )
        .setDescription(
          checks.join(
            '\n'
          )
        )
        .setFooter({
          text:
            `✦ ${BOT_NAME} • ${BOT_VERSION}`
        })
        .setTimestamp();

    await interaction.editReply({
      embeds: [
        embed
      ]
    });
  } catch (error) {
    logError(
      'DOCTOR',
      error
    );

    await tempReply(
      interaction,
      '❌ Không thể hoàn tất kiểm tra hệ thống.',
      {
        error: true
      }
    );
  }
}

async function reconcileCreateMessage(
  guild,
  generator
) {
  if (
    !generator?.create_channel_id
  ) {
    return;
  }

  let channel =
    guild.channels.cache.get(
      String(
        generator.create_channel_id
      )
    );

  if (!channel) {
    channel =
      await guild.channels.fetch(
        String(
          generator.create_channel_id
        )
      ).catch(
        () => null
      );
  }

  if (
    !channel ||
    !channel.isTextBased()
  ) {
    return;
  }

  let message =
    await fetchMessageSafe(
      channel,
      String(
        generator.create_message_id ||
        ''
      )
    );

  if (!message) {
    try {
      const recent =
        await channel.messages.fetch({
          limit: 50
        });

      message =
        recent.find(
          item =>
            item.author?.id ===
              client.user.id &&
            item.components?.some(
              row =>
                row.components?.some(
                  component =>
                    (
                      component.customId ||
                      component.custom_id
                    ) ===
                    'room_create'
                )
            )
        ) || null;
    } catch (error) {
      logError(
        'RECONCILE_CREATE_MESSAGE_SCAN',
        error
      );
    }
  }

  const payload =
    buildCreateRoomPanel(
      generator.display_name
    );

  if (message) {
    try {
      await message.edit(
        payload
      );
    } catch (error) {
      logError(
        'RECONCILE_CREATE_MESSAGE_EDIT',
        error
      );

      message = null;
    }
  }

  if (!message) {
    message =
      await channel.send(
        payload
      );
  }

  if (
    String(
      generator.create_message_id ||
      ''
    ) !==
    message.id
  ) {
    await pool.query(
      `
        UPDATE generators
        SET
          create_message_id = $1,
          updated_at = NOW()
        WHERE guild_id = $2
      `,
      [
        message.id,
        guild.id
      ]
    );
  }
}

async function reconcileGuild(
  guild
) {
  const generator =
    await getGenerator(
      guild.id
    );

  if (generator) {
    await reconcileCreateMessage(
      guild,
      generator
    ).catch(
      error => {
        logError(
          `RECONCILE_GENERATOR:${guild.id}`,
          error
        );
      }
    );
  }

  const rooms =
    await getGuildRooms(
      guild.id
    );

  for (
    const room
    of rooms
  ) {
    try {
      let channel =
        guild.channels.cache.get(
          String(
            room.channel_id
          )
        );

      if (!channel) {
        channel =
          await guild.channels.fetch(
            String(
              room.channel_id
            )
          ).catch(
            () => null
          );
      }

      if (
        !channel ||
        channel.type !==
          ChannelType.GuildVoice
      ) {
        await deleteRoomRecord(
          String(
            room.channel_id
          )
        );

        continue;
      }

      const owner =
        await getGuildMember(
          guild,
          String(
            room.owner_id
          )
        );

      if (!owner) {
        const candidates =
          channel.members.filter(
            member =>
              !member.user.bot
          );

        const replacement =
          candidates.first();

        if (replacement) {
          await updateRoomOwner(
            channel.id,
            replacement.id
          );

          await grantOwnerPermissions(
            channel,
            replacement.id
          );
        }
      } else {
        await grantOwnerPermissions(
          channel,
          owner.id
        );
      }

      await ensureBotRoomPermissions(
        channel
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
          channel.id,
          3000
        );
      } else {
        await refreshRoomPanelSafe(
          channel.id
        );
      }
    } catch (error) {
      logError(
        `RECONCILE_ROOM:${room.channel_id}`,
        error
      );
    }
  }
}

async function reconcileAllGuilds() {
  for (
    const guild
    of client.guilds.cache.values()
  ) {
    await reconcileGuild(
      guild
    ).catch(
      error => {
        logError(
          `RECONCILE_GUILD:${guild.id}`,
          error
        );
      }
    );
  }
}

async function handleVoiceStateUpdate(
  oldState,
  newState
) {
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

  if (
    oldChannelId
  ) {
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

  if (
    newChannelId
  ) {
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
}

async function handleChannelDelete(
  channel
) {
  if (
    !channel?.guild
  ) {
    return;
  }

  try {
    const room =
      await getRoom(
        channel.id
      );

    if (room) {
      clearPendingTransfer(
        channel.id
      );

      clearSelectionsForChannel(
        channel.guild.id,
        channel.id
      );

      await deleteRoomRecord(
        channel.id
      );

      await sendActionLog(
        channel.guild,
        '🗑️',
        BOT_NAME,
        `Xóa dữ liệu phòng ${channel.name}`
      );

      return;
    }

    const generator =
      await getGenerator(
        channel.guild.id
      );

    if (!generator) {
      return;
    }

    const updates = [];

    if (
      String(
        generator.create_channel_id ||
        ''
      ) ===
      channel.id
    ) {
      updates.push(
        'create_channel_id = NULL',
        'create_message_id = NULL'
      );
    }

    if (
      String(
        generator.chat_log_channel_id ||
        ''
      ) ===
      channel.id
    ) {
      updates.push(
        'chat_log_channel_id = NULL'
      );
    }

    if (
      String(
        generator.action_log_channel_id ||
        ''
      ) ===
      channel.id
    ) {
      updates.push(
        'action_log_channel_id = NULL'
      );
    }

    if (
      String(
        generator.button_category_id ||
        ''
      ) ===
      channel.id
    ) {
      updates.push(
        'button_category_id = NULL'
      );
    }

    if (
      String(
        generator.blog_category_id ||
        ''
      ) ===
      channel.id
    ) {
      updates.push(
        'blog_category_id = NULL'
      );
    }

    if (
      updates.length
    ) {
      await pool.query(
        `
          UPDATE generators
          SET
            ${updates.join(', ')},
            updated_at = NOW()
          WHERE guild_id = $1
        `,
        [
          channel.guild.id
        ]
      );
    }
  } catch (error) {
    logError(
      'CHANNEL_DELETE',
      error
    );
  }
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName(
        'setup'
      )
      .setDescription(
        'Cài đặt hoặc cài đặt lại Voice HDK'
      )
      .setDefaultMemberPermissions(
        PermissionsBitField.Flags.ManageGuild
      ),
    new SlashCommandBuilder()
      .setName(
        'panel'
      )
      .setDescription(
        'Khôi phục bảng điều khiển phòng Voice HDK'
      ),
    new SlashCommandBuilder()
      .setName(
        'claim'
      )
      .setDescription(
        'Nhận quyền chủ khi chủ cũ không còn trong phòng'
      ),
    new SlashCommandBuilder()
      .setName(
        'doctor'
      )
      .setDescription(
        'Kiểm tra trạng thái hệ thống Voice HDK'
      )
      .setDefaultMemberPermissions(
        PermissionsBitField.Flags.ManageGuild
      )
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
  if (
    interaction.isChatInputCommand()
  ) {
    switch (
      interaction.commandName
    ) {
      case 'setup':
        await handleSetupCommand(
          interaction
        );
        return;

      case 'panel':
        await handlePanelCommand(
          interaction
        );
        return;

      case 'claim':
        await handleClaimCommand(
          interaction
        );
        return;

      case 'doctor':
        await handleDoctorCommand(
          interaction
        );
        return;

      default:
        return;
    }
  }

  if (
    interaction.isModalSubmit()
  ) {
    switch (
      interaction.customId
    ) {
      case 'setup_name_modal':
        await handleSetupNameModal(
          interaction
        );
        return;

      case 'room_rename_modal':
        await handleRenameModal(
          interaction
        );
        return;

      case 'room_limit_modal':
        await handleLimitModal(
          interaction
        );
        return;

      default:
        return;
    }
  }

  if (
    interaction.isChannelSelectMenu()
  ) {
    switch (
      interaction.customId
    ) {
      case 'setup_button_category':
        await handleSetupCategorySelect(
          interaction,
          'button'
        );
        return;

      case 'setup_blog_category':
        await handleSetupCategorySelect(
          interaction,
          'blog'
        );
        return;

      default:
        return;
    }
  }

  if (
    interaction.isUserSelectMenu()
  ) {
    if (
      interaction.customId ===
      'room_member'
    ) {
      await handleMemberSelect(
        interaction
      );
    }

    return;
  }

  if (
    interaction.isStringSelectMenu()
  ) {
    if (
      interaction.customId ===
      'room_region'
    ) {
      await handleRegionSelect(
        interaction
      );
    }

    return;
  }

  if (
    interaction.isButton()
  ) {
    if (
      interaction.customId.startsWith(
        'transfer_accept:'
      ) ||
      interaction.customId.startsWith(
        'transfer_decline:'
      )
    ) {
      await handleTransferDecision(
        interaction
      );

      return;
    }

    switch (
      interaction.customId
    ) {
      case 'setup_name':
        await handleSetupNameButton(
          interaction
        );
        return;

      case 'setup_reinstall_confirm':
        await handleReinstallConfirm(
          interaction
        );
        return;

      case 'setup_reinstall_cancel':
        await handleReinstallCancel(
          interaction
        );
        return;

      case 'setup_install':
        await handleSetupInstall(
          interaction
        );
        return;

      case 'room_create':
        await handleCreateRoomButton(
          interaction
        );
        return;

      case 'room_lock':
        await handleRoomLock(
          interaction
        );
        return;

      case 'room_hide':
        await handleRoomHide(
          interaction
        );
        return;

      case 'room_rename':
        await handleRenameButton(
          interaction
        );
        return;

      case 'room_reset':
        await handleResetButton(
          interaction
        );
        return;

      case 'room_reset_confirm':
        await handleResetConfirm(
          interaction
        );
        return;

      case 'room_reset_cancel':
        await handleResetCancel(
          interaction
        );
        return;

      case 'room_limit':
        await handleLimitButton(
          interaction
        );
        return;

      case 'room_invite':
        await handleInviteMember(
          interaction
        );
        return;

      case 'room_transfer':
        await handleTransferButton(
          interaction
        );
        return;

      case 'room_deny':
        await handleDenyMember(
          interaction
        );
        return;

      case 'room_kick':
        await handleKickMember(
          interaction
        );
        return;

      default:
        return;
    }
  }
}

client.on(
  Events.InteractionCreate,
  interaction => {
    handleInteraction(
      interaction
    ).catch(
      async error => {
        logError(
          'INTERACTION',
          error
        );

        try {
          if (
            interaction.isRepliable()
          ) {
            if (
              interaction.deferred ||
              interaction.replied
            ) {
              await tempFollowUp(
                interaction,
                '❌ Đã xảy ra lỗi khi xử lý thao tác. Vui lòng thử lại.',
                {
                  error: true
                }
              );
            } else {
              await tempReply(
                interaction,
                '❌ Đã xảy ra lỗi khi xử lý thao tác. Vui lòng thử lại.',
                {
                  error: true
                }
              );
            }
          }
        } catch {
        }
      }
    );
  }
);

client.on(
  Events.VoiceStateUpdate,
  (
    oldState,
    newState
  ) => {
    handleVoiceStateUpdate(
      oldState,
      newState
    ).catch(
      error => {
        logError(
          'VOICE_STATE_UPDATE',
          error
        );
      }
    );
  }
);

client.on(
  Events.MessageCreate,
  message => {
    handleChatMessageCreate(
      message
    ).catch(
      error => {
        logError(
          'MESSAGE_CREATE',
          error
        );
      }
    );
  }
);

client.on(
  Events.MessageUpdate,
  (
    oldMessage,
    newMessage
  ) => {
    handleChatMessageUpdate(
      oldMessage,
      newMessage
    ).catch(
      error => {
        logError(
          'MESSAGE_UPDATE',
          error
        );
      }
    );
  }
);

client.on(
  Events.MessageDelete,
  message => {
    handleChatMessageDelete(
      message
    ).catch(
      error => {
        logError(
          'MESSAGE_DELETE',
          error
        );
      }
    );
  }
);

client.on(
  Events.ChannelDelete,
  channel => {
    handleChannelDelete(
      channel
    ).catch(
      error => {
        logError(
          'CHANNEL_DELETE_EVENT',
          error
        );
      }
    );
  }
);

client.once(
  Events.ClientReady,
  async readyClient => {
    try {
      console.log(
        `[${BOT_NAME}] Đã đăng nhập: ${readyClient.user.tag}`
      );

      await registerCommands();

      console.log(
        `[${BOT_NAME}] Slash Commands đã đăng ký.`
      );

      await reconcileAllGuilds();

      console.log(
        `[${BOT_NAME}] Kiểm tra dữ liệu khởi động hoàn tất.`
      );
    } catch (error) {
      logError(
        'CLIENT_READY',
        error
      );
    }
  }
);

async function shutdown(
  signal
) {
  console.log(
    `[${BOT_NAME}] Nhận ${signal}, đang tắt an toàn...`
  );

  try {
    client.destroy();
  } catch (error) {
    logError(
      'SHUTDOWN_DISCORD',
      error
    );
  }

  try {
    await pool.end();
  } catch (error) {
    logError(
      'SHUTDOWN_DATABASE',
      error
    );
  }

  try {
    healthServer.close();
  } catch {
  }

  process.exit(
    0
  );
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

        process.exit(
          1
        );
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

        process.exit(
          1
        );
      }
    );
  }
);

async function start() {
  await initDatabase();

  await new Promise(
    (
      resolve,
      reject
    ) => {
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
            `[${BOT_NAME}] Health server: 0.0.0.0:${PORT}`
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
    } catch {
    }

    throw error;
  }
}

start().catch(
  async error => {
    logError(
      'STARTUP',
      error
    );

    try {
      client.destroy();
    } catch {
    }

    try {
      await pool.end();
    } catch {
    }

    try {
      healthServer.close();
    } catch {
    }

    process.exit(
      1
    );
  }
);

// UPTIMEROBOT / RENDER FREE
// URL: https://TEN-SERVICE-CUA-BAN.onrender.com/health
// Method: GET
