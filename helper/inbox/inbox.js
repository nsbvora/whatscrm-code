const { query } = require("../../database/dbpromise");
const {
  getConnectionsByUid,
  sendToUid,
  sendRingToUid,
  sendToSocket,
} = require("../../socket");
const { mergeArraysWithPhonebook } = require("../socket/function");
const { processMetaMessage } = require("./meta");
const { metaChatbotInit } = require("../chatbot/meta");
const { processMessageQr } = require("../addon/qr/processThings");
const { processWebhook } = require("./chatbot");
const { processAutomation } = require("../../automation/automation");

async function updateChatListSocket({ connectionInfo }) {
  try {
    const limit = 10;
    const { uid, agent } = connectionInfo;
    let chats = [];

    if (agent) {
      const assignedChats = await query(
        `SELECT chat_id FROM agent_chats WHERE uid = ?`,
        [uid]
      );
      if (assignedChats.length) {
        const chatIds = assignedChats.map(({ chat_id }) => chat_id);
        chats = await query(
          `SELECT * FROM chats 
           WHERE chat_id IN (?) AND uid = ? 
           ORDER BY last_message_came DESC 
           LIMIT ?`,
          [
            chatIds,
            agent ? connectionInfo?.decodedValue?.owner_uid : uid,
            limit,
          ]
        );
      }
    } else {
      chats = await query(
        `SELECT * FROM chats 
         WHERE uid = ? 
         ORDER BY last_message_came DESC 
         LIMIT ?`,
        [uid, limit]
      );
    }

    const contacts = await query(`SELECT * FROM contact WHERE uid = ?`, [
      agent ? connectionInfo?.decodedValue?.owner_uid : uid,
    ]);
    const chatData = mergeArraysWithPhonebook(chats, contacts);

    return chatData || [];
  } catch (err) {
    console.log(err);
  }
}

async function processMessage({
  body,
  uid,
  origin,
  getSession,
  sessionId,
  qrType,
}) {
  try {
    // getting user data
    const [userData] = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);
    if (!userData) return;

    let latestConversation = [];

    switch (origin) {
      case "meta":
        const metaMsg = await processMetaMessage({
          body,
          uid,
          origin,
          userData,
        });
        latestConversation = metaMsg;
        break;
      case "qr":
        console.log("QR MESSAGE");
        const qrMsg = await processMessageQr({
          getSession,
          message: body,
          sessionId,
          type: qrType,
          uid,
          userData,
        });
        latestConversation = qrMsg;
        console.log("QR MESSAGE");
        break;
      default:
        break;
    }

    // // Send the latest chat list to all sockets of the user.
    const socketConnections = getConnectionsByUid(uid, true) || [];

    socketConnections.forEach(async (socket) => {
      sendToSocket(
        socket?.socketId,
        { chatId: latestConversation?.chatId },
        "request_update_chat_list"
      );
      if (latestConversation?.newMessage) {
        sendToSocket(socket?.socketId, {}, "ring");
      }
    });

    // chatbot init
    if (latestConversation?.newMessage && uid) {
      if (origin === "qr") {
        if (body?.key?.fromMe) {
          return;
        }
      }

      // Get user details
      const [user] = await query("SELECT * FROM user WHERE uid = ?", [uid]);
      if (!user) {
        return console.log("User not found");
      }

      // Process the message through the flow builder
      await processWebhook(latestConversation?.newMessage, user);

      await processAutomation({
        uid,
        message: latestConversation?.newMessage,
        user,
        sessionId,
        origin,
        chatId: latestConversation?.chatId,
      });

      // metaChatbotInit({
      //   latestConversation,
      //   uid,
      //   origin,
      //   conversationPath: conversationPath || null,
      //   sessionId,
      // });
    }
  } catch (err) {
    console.log(err);
  }
}

module.exports = { processMessage };
