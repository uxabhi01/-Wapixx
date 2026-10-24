import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import { config } from './config.js';
import { generateAIReply, initGemini } from './gemini.js';

// Initialize Gemini client
initGemini();

// Record bot startup time to filter out old/historical backlog messages
const botStartTime = Math.floor(Date.now() / 1000);
// 10-minute grace window to protect against clock drift between PC and WhatsApp servers
const BACKLOG_CUTOFF_SECONDS = 600;

// Track bot's own WhatsApp ID
let myWid = '';

// Track recent bot replies to avoid self-reply loops in self-chats ("Message yourself")
const recentBotReplies = new Set();

// Sequential queue per chat ID to handle rapid consecutive messages in order
const chatQueues = new Map();

function enqueueChatTask(chatId, task) {
  const currentPromise = chatQueues.get(chatId) || Promise.resolve();
  const nextPromise = currentPromise
    .then(task)
    .catch((err) => {
      console.error(`Error processing task for ${chatId}:`, err?.message || err);
    })
    .finally(() => {
      if (chatQueues.get(chatId) === nextPromise) {
        chatQueues.delete(chatId);
      }
    });
  chatQueues.set(chatId, nextPromise);
  return nextPromise;
}

// Initialize WhatsApp client
// Using LocalAuth strategy to persist session credentials in the ".wwebjs_auth" directory
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    handleSIGINT: false,
    timeout: 60000,
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  }
});

// Event: Display QR Code in Terminal for scanning (only if session not already saved)
client.on('qr', (qr) => {
  console.log('\n=============================================================================');
  console.log('ACTION REQUIRED: Scan the QR code below using your WhatsApp app to log in:');
  console.log('Go to WhatsApp > Linked Devices > Link a Device on your phone.');
  console.log('=============================================================================\n');
  qrcode.generate(qr, { small: true });
});

// Event: Successful login/authentication
client.on('authenticated', () => {
  console.log('Successfully authenticated with WhatsApp!');
});

// Event: Authentication failure
client.on('auth_failure', (msg) => {
  console.error('Authentication failure:', msg);
});

// Event: Disconnected
client.on('disconnected', (reason) => {
  console.warn(`\n[Disconnected] WhatsApp Client disconnected. Reason: ${reason}`);
  console.warn('Scan the QR code to re-link or restart the application.\n');
});

// Event: Bot is ready to receive and reply to messages
client.on('ready', () => {
  myWid = client.info?.wid?._serialized || '';
  console.log('\n=============================================================================');
  console.log('🤖 Wapixx WhatsApp Bot is ACTIVE and listening for messages!');
  console.log(`Connected Account: ${client.info?.pushname || 'User'} (${myWid || 'Ready'})`);
  console.log(`Auto-Reply Mode: ${config.autoReplyMode.toUpperCase()}`);
  console.log('Gemini API status: Ready');
  console.log('=============================================================================\n');
});

// Event: Handle incoming and self-test messages
// Using 'message_create' ensures both external contacts and developer self-testing are handled
client.on('message_create', async (msg) => {
  try {
    const rawSender = msg.from || '';
    const rawRecipient = msg.to || '';
    const cleanBody = (msg.body || '').trim();

    // 1. Loop and Self-Chat Protection
    const isSelfChat = Boolean(myWid && (rawRecipient === myWid || rawSender === rawRecipient));

    if (msg.fromMe) {
      // If sent by the bot account to an external contact, ignore (it is an outbound reply)
      if (!isSelfChat) {
        return;
      }

      // If in a self-chat ("Message yourself"), check if this message is our own bot reply echoing back
      if (recentBotReplies.has(cleanBody)) {
        recentBotReplies.delete(cleanBody);
        return;
      }
    }

    // Determine target chat ID
    const senderId = msg.fromMe ? (rawRecipient || rawSender) : (rawSender || '');
    if (!senderId) return;

    // 2. Safety Checks & Exclusions

    // Ignore status updates, broadcast lists, and system broadcasts
    if (
      msg.isStatus ||
      msg.broadcast ||
      senderId.endsWith('@broadcast') ||
      senderId.includes('status') ||
      senderId === 'status@broadcast'
    ) {
      return;
    }

    // Ignore group chats
    const isGroup = senderId.endsWith('@g.us') || Boolean(msg.isGroupMsg) || (msg.id?.remote && msg.id.remote.endsWith('@g.us'));
    if (isGroup) {
      return;
    }

    // Ignore WhatsApp Newsletters / Channels
    if (senderId.endsWith('@newsletter') || (msg.id?.remote && msg.id.remote.endsWith('@newsletter'))) {
      return;
    }

    // Ignore non-chat events (reactions, protocol notifications, call logs, etc.)
    if (msg.type && msg.type !== 'chat') {
      return;
    }

    // Ignore empty messages
    if (!cleanBody) return;

    // Ignore old historical backlog synced upon initial startup (with a 10-minute safe grace window)
    if (msg.timestamp && msg.timestamp < botStartTime - BACKLOG_CUTOFF_SECONDS) {
      console.log(`[Ignored] Backlog message from ${senderId} (message timestamp: ${msg.timestamp}, cutoff: ${botStartTime - BACKLOG_CUTOFF_SECONDS})`);
      return;
    }

    // Check Whitelist (Self-test chat is always allowed)
    if (!isSelfChat && !config.isChatAllowed(senderId)) {
      console.log(`[Ignored] Message received from ${senderId} - Chat not whitelisted.`);
      return;
    }

    // 3. Resolve Sender Name (Instant & synchronous - avoids hanging promises)
    const senderDisplayName = msg.pushname || msg._data?.notifyName || senderId.replace(/@.*$/, '');

    console.log(`\n📩 [Received] From: ${senderDisplayName} (${senderId}): "${cleanBody}"`);

    // 4. Enqueue response processing for this chat to prevent race conditions
    enqueueChatTask(senderId, async () => {
      // Trigger "typing..." indicator in the background without awaiting (avoids browser evaluate hangs)
      msg.getChat()
        .then((chat) => {
          if (chat && typeof chat.sendStateTyping === 'function') {
            chat.sendStateTyping().catch(() => {});
          }
        })
        .catch(() => {});

      // Add a small natural delay based on prompt length (800ms - 2000ms)
      const simulatedDelayMs = Math.min(Math.max(cleanBody.length * 15, 800), 2000);
      await new Promise((resolve) => setTimeout(resolve, simulatedDelayMs));

      // Generate AI Reply using Gemini
      console.log(`🤖 [AI] Thinking reply for ${senderDisplayName}...`);
      const aiResponse = await generateAIReply(senderId, cleanBody);

      // Clear typing indicator in the background
      msg.getChat()
        .then((chat) => {
          if (chat && typeof chat.clearState === 'function') {
            chat.clearState().catch(() => {});
          }
        })
        .catch(() => {});

      // Register reply in loop protection cache
      recentBotReplies.add(aiResponse.trim());
      setTimeout(() => {
        recentBotReplies.delete(aiResponse.trim());
      }, 30000);

      // 5. Send Response (Prefer direct sendMessage, fallback to msg.reply)
      let sentSuccess = false;
      try {
        await client.sendMessage(senderId, aiResponse);
        sentSuccess = true;
      } catch (sendErr) {
        console.warn(`[Fallback] Direct sendMessage failed (${sendErr?.message || sendErr}), attempting msg.reply...`);
        try {
          await msg.reply(aiResponse);
          sentSuccess = true;
        } catch (replyErr) {
          console.error(`[Error] Failed to send reply to ${senderId}:`, replyErr?.message || replyErr);
        }
      }

      if (sentSuccess) {
        console.log(`📤 [Replied] To: ${senderDisplayName} (${senderId}):\n"${aiResponse}"\n`);
      }
    });

  } catch (error) {
    console.error('Error handling message:', error?.message || error);
    if (error?.stack) {
      console.error(error.stack);
    }
  }
});

// Handle graceful process termination
let isShuttingDown = false;
const handleShutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\nGracefully shutting down WhatsApp Client...');
  try {
    await client.destroy();
    console.log('WhatsApp Client connection closed.');
  } catch (err) {
    console.error('Error during client destruction:', err?.message || err);
  }
  process.exit(0);
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

// Start initialization
console.log('Initializing WhatsApp Client...');
client.initialize().catch((err) => {
  console.error('Failed to initialize WhatsApp client:', err?.message || err);
});
