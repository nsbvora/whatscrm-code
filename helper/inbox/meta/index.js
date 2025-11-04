const { query } = require("../../../database/dbpromise");
const axios = require("axios");
const randomstring = require("randomstring");
const moment = require("moment");
const mime = require("mime-types");
const fs = require("fs");
const path = require("path");

// Utility Functions
function getCurrentTimestamp() {
  return Math.round(Date.now() / 1000);
}

function extractPhoneNumber(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)/);
  return match ? match[1] : null;
}

function formatMessage(type, content) {
  return { type, [type]: content };
}

// Media Handling
async function downloadAndSaveMedia(token, mediaId, uid) {
  try {
    const { data: mediaData } = await axios.get(
      `https://graph.facebook.com/v19.0/${mediaId}/`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!mediaData.url) throw new Error("Media URL not found");

    const response = await axios.get(mediaData.url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: "arraybuffer",
    });

    const ext = mime.extension(response.headers["content-type"]) || "bin";
    const fileName = `${randomstring.generate(10)}.${ext}`;
    const filePath = path.resolve(
      __dirname,
      "../../../client/public/meta-media",
      fileName
    );

    // Ensure directory exists
    if (!fs.existsSync(path.dirname(filePath))) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }

    fs.writeFileSync(filePath, response.data);
    return fileName;
  } catch (err) {
    console.error("Media download error:", err.message);
    return null;
  }
}

// Database Operations
async function updateChatInMysql({
  chatId,
  uid,
  senderName,
  senderMobile,
  actualMsg,
  body,
}) {
  try {
    const allowedMessageTypes = ["text", "image", "document", "video", "audio"];
    const isIncoming = actualMsg?.route === "INCOMING";

    // Check if chat exists
    const [chat] = await query(
      `SELECT * FROM beta_chats 
       WHERE uid = ? AND chat_id = ?`,
      [uid, chatId]
    );

    const updateFields = {
      last_message: JSON.stringify(actualMsg),
      sender_name: senderName || "NA",
      sender_mobile: senderMobile || "NA",
      origin: "meta",
    };

    if (isIncoming && allowedMessageTypes.includes(actualMsg?.type)) {
      updateFields.unread_count = chat?.unread_count
        ? chat.unread_count + 1
        : 1;
    }

    if (chat) {
      await query(`UPDATE beta_chats SET ? WHERE chat_id = ? AND uid = ?`, [
        updateFields,
        chatId,
        uid,
      ]);
    } else {
      await query(`INSERT INTO beta_chats SET ?`, {
        ...updateFields,
        uid,
        origin_instance_id: JSON.stringify({
          id:
            body.entry?.[0]?.changes?.[0]?.value?.metadata
              ?.display_phone_number || chatId,
        }),
        chat_id: chatId,
        unread_count: isIncoming ? 1 : 0,
        assigned_agent: null,
        createdAt: new Date(),
      });
    }

    return true;
  } catch (err) {
    console.error("Chat update error:", err);
    return false;
  }
}

async function saveMessageToConversation({ uid, chatId, messageData }) {
  try {
    await query(`INSERT INTO beta_conversation SET ?`, {
      type: messageData.type,
      metaChatId: messageData.metaChatId,
      msgContext: JSON.stringify(messageData.msgContext),
      reaction: messageData.reaction || "",
      timestamp: messageData.timestamp || getCurrentTimestamp(),
      senderName: messageData.senderName,
      senderMobile: messageData.senderMobile,
      star: messageData.star ? 1 : 0,
      route: messageData.route,
      context: messageData.context ? JSON.stringify(messageData.context) : null,
      origin: messageData.origin,
      uid,
      chat_id: chatId,
      status: messageData.status || "",
      createdAt: new Date(),
    });
    return true;
  } catch (err) {
    console.error("Message save error:", err);
    return false;
  }
}

// Message Processing
async function processMediaMessage(type, message, uid) {
  try {
    const [{ access_token: token }] = await query(
      `SELECT access_token FROM meta_api WHERE uid = ?`,
      [uid]
    );
    if (!token) return null;

    const mediaId = message[type]?.id;
    if (!mediaId) return null;

    const fileName = await downloadAndSaveMedia(token, mediaId, uid);
    if (!fileName) return null;

    const content = {
      link: `${process.env.FRONTENDURI}/meta-media/${fileName}`,
    };
    if (message[type]?.caption) content.caption = message[type].caption;

    return formatMessage(type, content);
  } catch (err) {
    console.error("Media processing error:", err);
    return null;
  }
}

async function processMetaMsg({ body, uid }) {
  try {
    if (!body?.entry?.[0]?.changes?.[0]?.value) return null;

    const value = body.entry[0].changes[0].value;
    const messages = value.messages || [];
    const statuses = value.statuses || [];
    if (!messages.length && !statuses.length) return null;

    const message = messages[0] || null;
    let msgContext = null;
    let statusType = "";
    let newMessage = null;

    // Process status updates
    if (statuses.length) {
      const status = statuses[0];
      statusType =
        status.status === "sent"
          ? "sent"
          : status.status === "delivered"
          ? "delivered"
          : status.status === "read"
          ? "read"
          : status.status === "failed"
          ? "failed"
          : "";

      if (statusType) {
        await query(
          `UPDATE beta_conversation SET status = ? 
           WHERE metaChatId = ? AND uid = ?`,
          [statusType, status.id, uid]
        );
      }
    }

    // Process message content
    if (message) {
      const msgType = message.type;
      const interactive = message.interactive;
      const button = message?.button?.text;

      switch (msgType) {
        case "text":
          msgContext = formatMessage("text", {
            body: message.text.body,
            preview_url: true,
          });
          break;
        case "image":
        case "video":
        case "document":
        case "audio":
          msgContext = await processMediaMessage(msgType, message, uid);
          break;
        case "interactive":
          if (interactive?.button_reply) {
            msgContext = formatMessage("text", {
              body: interactive.button_reply.title,
              preview_url: false,
            });
          } else if (interactive?.list_reply) {
            msgContext = formatMessage("text", {
              body: interactive.list_reply.title,
              preview_url: false,
            });
          }
          break;
        case "location":
          msgContext = formatMessage("location", {
            latitude: message.location.latitude,
            longitude: message.location.longitude,
            name: message.location.name || "",
            address: message.location.address || "",
          });
          break;
        default:
          if (button) {
            msgContext = formatMessage("text", {
              body: button,
              preview_url: false,
            });
          }
      }

      if (msgContext) {
        newMessage = {
          type: msgContext.type,
          metaChatId: message.id,
          msgContext,
          reaction: "",
          timestamp: getCurrentTimestamp(),
          senderName: value?.contacts?.[0]?.profile?.name || "NA",
          senderMobile: value?.contacts?.[0]?.wa_id || "NA",
          status: statusType,
          star: false,
          route: "INCOMING",
          context: message.context || null,
          origin: "meta",
        };

        const chatId = `meta_${
          extractPhoneNumber(value?.contacts?.[0]?.wa_id) ||
          randomstring.generate(10)
        }`;

        await saveMessageToConversation({
          uid,
          chatId,
          messageData: newMessage,
        });

        await updateChatInMysql({
          chatId,
          uid,
          senderName: newMessage.senderName,
          senderMobile: newMessage.senderMobile,
          actualMsg: newMessage,
          body,
        });
      }
    }

    const chatIdd = `meta_${
      extractPhoneNumber(value?.contacts?.[0]?.wa_id) ||
      randomstring.generate(10)
    }`;

    return { newMessage, chatId: chatIdd };
  } catch (err) {
    console.error("Message processing error:", err);
    return null;
  }
}

// Main Entry Point
async function processMetaMessage({ body, uid }) {
  try {
    const data = await processMetaMsg({ body, uid });
    return data;
  } catch (err) {
    console.error("Meta message processing failed:", err);
    return null;
  }
}

module.exports = { processMetaMessage };
