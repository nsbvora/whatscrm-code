const fs = require("fs");
const fsPromise = require("fs").promises;
const path = require("path");
const moment = require("moment-timezone");
const { query } = require("../database/dbpromise");
const { default: axios } = require("axios");
const randomstring = require("randomstring");
const { getIOInstance } = () => {};
const fetch = require("node-fetch");
const mime = require("mime-types");
const nodemailer = require("nodemailer");
const unzipper = require("unzipper");
const { destributeTaskFlow } = require("./chatbot");
const { URLSearchParams } = require("url");
const mysql = require("mysql2/promise");

async function executeMySQLQuery(config) {
  let connection;
  try {
    // Create connection using provided config
    connection = await mysql.createConnection({
      host: config.connection.host,
      port: config.connection.port,
      user: config.connection.username,
      password: config.connection.password,
      database: config.connection.database,
      ssl: config.connection.ssl ? { rejectUnauthorized: false } : undefined,
    });

    // Execute query
    const [rows] = await connection.query(config.query, config.variables);

    return {
      success: true,
      data: rows,
      moveToNextNode: config.moveToNextNode,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      sqlState: error.code,
      moveToNextNode: false, // Always halt on error
    };
  } finally {
    // Close connection if it was created
    if (connection) await connection.end();
  }
}

async function makeRequestBeta(config, variables = {}) {
  // Helper function to substitute variables in strings
  const substituteVariables = (str) => {
    if (typeof str !== "string") return str;
    return str.replace(/\{\{\{(.+?)\}\}\}/g, (match, varName) => {
      return variables[varName] !== undefined ? variables[varName] : match;
    });
  };

  // Validate configuration
  if (!config)
    return { success: false, data: {}, msg: "Configuration is required" };
  if (!config.method)
    return { success: false, data: {}, msg: "HTTP method is required" };
  if (!config.url) return { success: false, data: {}, msg: "URL is required" };

  // Substitute variables in URL
  const url = substituteVariables(config.url);

  // Prepare headers with variable substitution
  const headers = {};
  (config.headers || []).forEach((header) => {
    if (header.key && header.value) {
      headers[substituteVariables(header.key)] = substituteVariables(
        header.value
      );
    }
  });

  // Prepare body based on content type
  let body;
  const contentType = config.contentType || "application/json";

  switch (contentType) {
    case "application/json":
      if (config.bodyInputMode === "visual" && config.bodyData?.json) {
        // Build JSON from visual editor data
        const jsonObj = {};
        config.bodyData.json.forEach((item) => {
          if (item.enabled !== false && item.key) {
            try {
              jsonObj[substituteVariables(item.key)] = JSON.parse(
                substituteVariables(item.value)
              );
            } catch {
              jsonObj[substituteVariables(item.key)] = substituteVariables(
                item.value
              );
            }
          }
        });
        body = JSON.stringify(jsonObj);
      } else {
        // Use raw JSON body with variable substitution
        body = substituteVariables(config.bodyData?.raw || "{}");
        // Validate JSON if in raw mode
        if (config.bodyInputMode !== "visual") {
          try {
            JSON.parse(body);
          } catch (error) {
            throw new Error(`Invalid JSON: ${error.message}`);
          }
        }
      }
      break;

    case "application/x-www-form-urlencoded":
      if (config.bodyInputMode === "visual" && config.bodyData?.urlEncoded) {
        const params = new URLSearchParams();
        config.bodyData.urlEncoded.forEach((item) => {
          if (item.enabled !== false && item.key) {
            params.append(
              substituteVariables(item.key),
              substituteVariables(item.value)
            );
          }
        });
        body = params.toString();
      } else {
        body = substituteVariables(config.bodyData?.raw || "");
      }
      break;

    default:
      // For text/plain, application/xml, etc.
      body = substituteVariables(config.bodyData?.raw || "");
  }

  // Set up abort controller for timeout (50 seconds)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 50000);

  try {
    const response = await fetch(url, {
      method: config.method,
      headers,
      body: ["GET", "HEAD"].includes(config.method.toUpperCase())
        ? undefined
        : body,
      signal: controller.signal,
      redirect: "follow",
      timeout: 50000,
    });

    clearTimeout(timeout);

    // Process response headers
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // Process response body based on content type
    let responseBody;
    const responseContentType = response.headers.get("content-type") || "";

    if (responseContentType.includes("application/json")) {
      responseBody = await response.json();
    } else if (
      responseContentType.includes("text/") ||
      responseContentType.includes("application/xml")
    ) {
      responseBody = await response.text();
    } else {
      responseBody = await response.buffer();
    }

    return {
      success: true,
      data: {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: responseBody,
        ok: response.ok,
        redirected: response.redirected,
        url: response.url,
      },
    };
  } catch (error) {
    clearTimeout(timeout);
    console.log(error);
    return { success: false, msg: "Request timed out after 50 seconds" };
  }
}

async function importConversationsFromJson({
  newChatId,
  uid,
  senderName,
  senderMobile,
  convos,
  batchSize = 50,
}) {
  if (!Array.isArray(convos) || convos.length === 0) {
    console.log("No conversation data to import.");
    return;
  }

  const batches = chunkArray(convos, batchSize);
  let totalInserted = 0;
  let totalFailed = 0;

  function toMySQLTimestamp(unix) {
    if (typeof unix !== "number" || isNaN(unix)) return null;
    const date = new Date(unix * 1000);
    if (isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 19).replace("T", " ");
  }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`Processing conversation batch ${i + 1}`);

    const results = await Promise.all(
      batch.map(async (convo, index) => {
        try {
          await query(
            `INSERT INTO beta_conversation 
              (type, chat_id, uid, status, metaChatId, msgContext, reaction, timestamp, senderName, senderMobile, star, route, context, origin, createdAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              convo.type || "text",
              newChatId,
              uid,
              convo.status || "",
              convo.metaChatId || "",
              JSON.stringify(convo.msgContext || {}),
              convo.reaction || null,
              convo.timestamp || Math.floor(Date.now() / 1000),
              senderName,
              senderMobile,
              convo.star ? 1 : 0,
              convo.route || "OUTGOING",
              convo.context ? JSON.stringify(convo.context) : null,
              convo.origin || "meta",
              toMySQLTimestamp(convo.timestamp),
            ]
          );
          return { success: true };
        } catch (err) {
          console.error(`Error inserting conversation ${index + 1}:`, err);
          return { success: false };
        }
      })
    );

    const inserted = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    totalInserted += inserted;
    totalFailed += failed;

    console.log(
      `Batch ${i + 1} done. Inserted: ${inserted}, Failed: ${failed}`
    );

    if (i < batches.length - 1) {
      await new Promise((res) => setTimeout(res, 100));
    }
  }

  console.log(
    `\nIMPORT COMPLETE. Total Inserted: ${totalInserted}, Failed: ${totalFailed}`
  );
}

// Function to split array into chunks
function chunkArray(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

async function checkExistingChat(uid, chatId) {
  try {
    const [existing] = await query(
      `SELECT 1 FROM beta_chats WHERE uid = ? AND chat_id = ? LIMIT 1`,
      [uid, chatId]
    );
    return !!existing;
  } catch (err) {
    console.error("Error checking existing chat:", err);
    return false; // Assume not exists if there's an error
  }
}

async function processBatch(batch, batchNumber) {
  console.log(`Processing batch ${batchNumber} with ${batch.length} items`);

  const insertPromises = batch.map(async (chat) => {
    try {
      // Parse the last_message JSON
      const lastMessage = JSON.parse(chat.last_message || "{}");

      // Determine origin_instance_id
      let originInstanceId = "{}";
      if (chat.other) {
        try {
          const other = JSON.parse(chat.other);
          if (other && typeof other === "object") {
            originInstanceId = JSON.stringify(other);
          }
        } catch (e) {
          console.error("Error parsing other field:", e);
        }
      }

      // Generate chat_id based on rules
      let chatId;
      try {
        const other = chat.other ? JSON.parse(chat.other) : {};
        let whatsappNumber = "";

        // Extract whatsapp number from other.id if it exists
        if (
          other.id &&
          typeof other.id === "string" &&
          other.id.includes("@s.whatsapp.net")
        ) {
          whatsappNumber = other.id.split("@")[0].split(":")[0];
        }

        if (whatsappNumber) {
          chatId = `${whatsappNumber}_${chat.sender_mobile}_${chat.uid}`;
        } else {
          // Fallback to meta_senderMobile if no whatsapp number found
          chatId = `meta_${chat.sender_mobile}`;
        }
      } catch (e) {
        console.error("Error generating chat_id:", e);
        chatId = `meta_${chat.sender_mobile}`;
      }

      // Check if chat already exists with same uid and chat_id
      const exists = await checkExistingChat(chat.uid, chatId);
      if (exists) {
        console.log(
          `Skipping duplicate chat: uid ${chat.uid}, chat_id ${chatId}`
        );
        return { success: true, id: chat.id, skipped: true };
      }

      await query(
        `INSERT INTO beta_chats (
          id,
          uid,
          old_chat_id,
          profile,
          origin_instance_id,
          chat_id,
          last_message,
          chat_label,
          chat_note,
          sender_name,
          sender_mobile,
          unread_count,
          origin,
          assigned_agent,
          createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          chat.id, // auto-generated ID
          chat.uid,
          chat.chat_id || null, // old_chat_id
          chat.profile ? JSON.stringify({ profileImage: chat.profile }) : null,
          originInstanceId,
          chatId, // newly generated chat_id
          JSON.stringify({
            type: lastMessage.type || "text",
            metaChatId: lastMessage.metaChatId || "",
            msgContext: lastMessage.msgContext || {
              type: "text",
              text: { preview_url: true, body: "" },
            },
            reaction: lastMessage.reaction || "",
            timestamp: lastMessage.timestamp || Math.floor(Date.now() / 1000),
            senderName: lastMessage.senderName || chat.sender_name || "",
            senderMobile: lastMessage.senderMobile || chat.sender_mobile || "",
            status: lastMessage.status || "",
            star: lastMessage.star || false,
            route: lastMessage.route || "OUTGOING",
            context: lastMessage.context || null,
            origin: chat.origin || "meta",
          }),
          chat.chat_tags ? chat.chat_tags : null,
          chat.chat_note || null,
          chat.sender_name || "",
          chat.sender_mobile || "",
          chat.is_opened === 1 ? 1 : 0,
          chat.origin || "meta",
          null, // assigned_agent
          chat.createdAt ? new Date(chat.createdAt) : new Date(),
        ]
      );
      return { success: true, id: chat.id };
    } catch (err) {
      console.log(`Error inserting chat ${chat.id}:`, err);
      return { success: false, id: chat.id, error: err };
    }
  });

  return Promise.all(insertPromises);
}

async function importChatsFromv3({ chatData }) {
  try {
    console.log(`Total chats to be imported: ${chatData.length}`);

    // First deduplicate chats to keep only the latest version of each chat
    const chatIdMap = new Map();
    const uniqueChats = chatData.filter((chat) => {
      try {
        // Generate chat_id to use as deduplication key
        let chatId;
        const other = chat.other ? JSON.parse(chat.other) : {};
        let whatsappNumber = "";

        if (
          other.id &&
          typeof other.id === "string" &&
          other.id.includes("@s.whatsapp.net")
        ) {
          whatsappNumber = other.id.split("@")[0].split(":")[0];
        }

        chatId = whatsappNumber
          ? `${whatsappNumber}_${chat.sender_mobile}_${chat.uid}`
          : `meta_${chat.sender_mobile}`;

        const existingChat = chatIdMap.get(chatId);
        if (existingChat) {
          const existingDate = new Date(existingChat.createdAt);
          const currentDate = new Date(chat.createdAt);
          if (currentDate > existingDate) {
            chatIdMap.set(chatId, chat);
          }
          return false; // Skip this one as it's not the latest
        } else {
          chatIdMap.set(chatId, chat);
          return true;
        }
      } catch (e) {
        console.error("Error processing chat for deduplication:", chat.id, e);
        return true; // Keep it if we can't process it
      }
    });

    console.log(
      `Total unique chats after deduplication: ${uniqueChats.length}`
    );

    const batchSize = 40;
    const batches = chunkArray(uniqueChats, batchSize);

    let totalSuccessful = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    const allFailedResults = [];

    for (let i = 0; i < batches.length; i++) {
      try {
        const results = await processBatch(batches[i], i + 1);

        const successful = results.filter(
          (r) => r.success && !r.skipped
        ).length;
        const skipped = results.filter((r) => r.skipped).length;
        const failed = results.filter((r) => !r.success).length;

        totalSuccessful += successful;
        totalSkipped += skipped;
        totalFailed += failed;

        // Collect failed results
        allFailedResults.push(...results.filter((r) => !r.success));

        console.log(
          `Batch ${
            i + 1
          } complete. Success: ${successful}, Skipped: ${skipped}, Failed: ${failed}`
        );

        // Small delay between batches to be gentle on the database
        if (i < batches.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } catch (err) {
        console.log(`Error processing batch ${i + 1}:`, err);
      }
    }

    console.log(
      `\nIMPORT COMPLETE. Total Success: ${totalSuccessful}, Total Skipped: ${totalSkipped}, Total Failed: ${totalFailed}`
    );

    // Log failed inserts if any
    if (totalFailed > 0) {
      console.log("Failed inserts:", allFailedResults);
    }
  } catch (err) {
    console.log(err);
  }
}

async function saveMessageToConversation({ uid, chatId, messageData }) {
  try {
    await query(`INSERT INTO beta_conversation SET ?`, {
      type: messageData.type,
      metaChatId: messageData.metaChatId,
      msgContext: JSON.stringify(messageData.msgContext),
      reaction: messageData.reaction || "",
      timestamp: messageData.timestamp,
      senderName: messageData.senderName,
      senderMobile: messageData.senderMobile,
      star: messageData.star ? 1 : 0,
      route: messageData.route,
      context: messageData.context ? JSON.stringify(messageData.context) : null,
      origin: messageData.origin,
      uid,
      chat_id: chatId,
    });
    return true;
  } catch (err) {
    console.log("Error saving message to conversation:", err);
    return false;
  }
}

async function executeQueries(queries, pool) {
  try {
    const connection = await pool.getConnection(); // Get a connection from the pool
    for (const query of queries) {
      await connection.query(query);
    }
    connection.release(); // Release the connection back to the pool
    return { success: true };
  } catch (err) {
    return { success: false, err };
  }
}

function findTargetNodes(nodes, edges, incomingWord) {
  const matchingEdges = edges.filter(
    (edge) => edge.sourceHandle === incomingWord
  );
  const targetNodeIds = matchingEdges.map((edge) => edge.target);
  const targetNodes = nodes.filter((node) => targetNodeIds.includes(node.id));
  return targetNodes;
}

function checkAssignAi(nodes) {
  try {
    const check = nodes.filter((x) => x?.data?.msgContent?.assignAi === true);
    return check?.length > 0 ? check : [];
  } catch (err) {
    console.log(err);
    return [];
  }
}

function getReply(nodes, edges, incomingWord) {
  const getNormal = findTargetNodes(nodes, edges, incomingWord);
  if (getNormal.length > 0) {
    return getNormal;
  } else if (checkAssignAi(nodes)?.length > 0) {
    const findAiNodes = checkAssignAi(nodes);
    return findAiNodes;
  } else {
    const getOther = findTargetNodes(nodes, edges, "{{OTHER_MSG}}");
    return getOther;
  }
}

async function runChatbot(i, incomingMsg, uid, senderNumber, toName) {
  const chatbot = i;
  const forAll = i?.for_all > 0 ? true : false;

  if (!forAll) {
    // checking if number is there
    const numberArr = JSON.parse(chatbot?.chats);
    const chatId = convertNumberToRandomString(senderNumber || "");
    const flow = JSON.parse(i?.flow);

    if (numberArr.includes(senderNumber)) {
      const nodePath = `${__dirname}/../flow-json/nodes/${uid}/${flow?.flow_id}.json`;
      const edgePath = `${__dirname}/../flow-json/edges/${uid}/${flow?.flow_id}.json`;

      const nodes = readJsonFromFile(nodePath);
      const edges = readJsonFromFile(edgePath);

      if (nodes.length > 0 && edges.length > 0) {
        const answer = getReply(nodes, edges, incomingMsg);

        if (answer.length > 0) {
          for (const k of answer) {
            await destributeTaskFlow({
              uid: uid,
              k: k,
              chatbotFromMysq: chatbot,
              toName: toName,
              senderNumber,
              sendMetaMsg,
              chatId,
              nodes,
              edges,
              incomingMsg,
              flowData: flow,
            });
          }
        }
      }
    }
  } else {
    const chatId = convertNumberToRandomString(senderNumber || "");
    const flow = JSON.parse(i?.flow);

    const nodePath = `${__dirname}/../flow-json/nodes/${uid}/${flow?.flow_id}.json`;
    const edgePath = `${__dirname}/../flow-json/edges/${uid}/${flow?.flow_id}.json`;

    const nodes = readJsonFromFile(nodePath);
    const edges = readJsonFromFile(edgePath);

    if (nodes.length > 0 && edges.length > 0) {
      const answer = getReply(nodes, edges, incomingMsg);

      console.log({ answer2: JSON.stringify(answer) });

      if (answer.length > 0) {
        for (const k of answer) {
          await destributeTaskFlow({
            uid: uid,
            k: k,
            chatbotFromMysq: chatbot,
            toName: toName,
            senderNumber,
            sendMetaMsg,
            chatId,
            nodes,
            edges,
            incomingMsg,
            flowData: flow,
          });
        }
      }
    }
  }
}

async function botWebhook(incomingMsg, uid, senderNumber, toName) {
  console.log("botWebhook RAN");

  const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);
  if (getUser[0]?.plan) {
    const plan = JSON.parse(getUser[0]?.plan);
    if (plan.allow_chatbot > 0) {
      const chatbots = await query(
        `SELECT * FROM chatbot WHERE uid = ? AND active = ?`,
        [uid, 1]
      );

      if (chatbots.length > 0) {
        await Promise.all(
          chatbots.map((i) =>
            runChatbot(i, incomingMsg, uid, senderNumber, toName)
          )
        );
      }
    } else {
      await query(`UPDATE chatbot SET active = ? WHERE uid = ?`, [0, uid]);
    }
  }
}

async function saveMessage(body, uid, type, msgContext) {
  try {
    console.log("CAME HERE");

    const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);
    const userTimezone = getCurrentTimestampInTimeZone(
      getUser[0]?.timezone || Date.now() / 1000
    );

    const chatId = convertNumberToRandomString(
      body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id,
      body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA"
    );

    const actualMsg = {
      type: type,
      metaChatId: body?.entry[0]?.changes[0]?.value?.messages[0]?.id,
      msgContext: msgContext,
      reaction: "",
      timestamp: userTimezone,
      senderName: body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA",
      senderMobile: body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id
        : "NA",
      status: "",
      star: false,
      route: "INCOMING",
      context: body?.entry[0]?.changes[0]?.value?.messages[0]
        ? body?.entry[0]?.changes[0]?.value?.messages[0]?.context
        : "",
    };

    // find chat
    const chat = await query(
      `SELECT * FROM chats WHERE chat_id = ? AND uid = ?`,
      [chatId, uid]
    );

    if (chat.length < 1) {
      await query(
        `INSERT INTO chats (chat_id, uid, last_message_came, sender_name, sender_mobile, last_message, is_opened) VALUES (
            ?,?,?,?,?,?,?
        )`,
        [
          chatId,
          uid,
          userTimezone,
          body?.entry[0]?.changes
            ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
            : "NA",
          body?.entry[0]?.changes
            ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id
            : "NA",
          JSON.stringify(actualMsg),
          0,
        ]
      );
    } else {
      await query(
        `UPDATE chats SET last_message_came = ?, last_message = ?, is_opened = ? WHERE chat_id = ? AND uid = ?`,
        [userTimezone, JSON.stringify(actualMsg), 0, chatId, uid]
      );
    }

    const chatPath = `${__dirname}/../conversations/inbox/${uid}/${chatId}.json`;
    addObjectToFile(actualMsg, chatPath);

    const io = getIOInstance();

    const getId = await query(`SELECT * FROM rooms WHERE uid = ?`, [uid]);

    const chats = await query(`SELECT * FROM chats WHERE uid = ?`, [uid]);

    io.to(getId[0]?.socket_id).emit("update_conversations", { chats: chats });

    io.to(getId[0]?.socket_id).emit("push_new_msg", {
      msg: actualMsg,
      chatId: chatId,
    });

    // checking if the agent has this chat
    const getAgentChat = await query(
      `SELECT * FROM agent_chats WHERE owner_uid = ? AND chat_id = ?`,
      [uid, chatId]
    );

    if (getAgentChat.length > 0) {
      const getMyChatsId = await query(
        `SELECT * FROM agent_chats WHERE uid = ?`,
        [getAgentChat[0]?.uid]
      );

      const chatIds = getMyChatsId.map((i) => i?.chat_id);

      const chatsNew = await query(
        `SELECT * FROM chats WHERE chat_id IN (?) AND uid = ?`,
        [chatIds, uid]
      );

      const getAgentSocket = await query(`SELECT * FROM rooms WHERE uid = ?`, [
        getAgentChat[0]?.uid,
      ]);
      io.to(getAgentSocket[0]?.socket_id).emit("update_conversations", {
        chats: chatsNew || [],
      });

      io.to(getAgentSocket[0]?.socket_id).emit("push_new_msg", {
        msg: actualMsg,
        chatId: chatId,
      });
    }
  } catch (err) {
    console.log(`error in saveMessage in function `, err);
  }
}

async function saveWebhookConversation(body, uid) {
  //  saving simple text
  if (
    body?.entry[0]?.changes[0]?.value?.messages &&
    body?.entry[0]?.changes[0]?.value?.messages[0]?.type === "text"
  ) {
    saveMessage(body, uid, "text", {
      type: "text",
      text: {
        preview_url: true,
        body: body?.entry[0]?.changes[0]?.value?.messages[0]?.text?.body,
      },
    });

    botWebhook(
      body?.entry[0]?.changes[0]?.value?.messages[0]?.text?.body,
      uid,
      body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id,
      body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA"
    );
  }

  // images
  else if (
    body?.entry[0]?.changes[0]?.value?.messages &&
    body?.entry[0]?.changes[0]?.value?.messages[0]?.image
  ) {
    const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);

    const metAPI = await query(`SELECT * FROM meta_api WHERE uid = ?`, [uid]);
    const metaToken = metAPI[0]?.access_token;

    if (metaToken) {
      console.log({ metaToken });
      const fileName = await downloadAndSaveMedia(
        metaToken,
        body?.entry[0]?.changes[0]?.value?.messages[0]?.image?.id
      );
      console.log({ fileName });
      saveMessage(body, uid, "image", {
        type: "image",
        image: {
          link: `${process.env.FRONTENDURI}/meta-media/${fileName}`,
          caption:
            body?.entry[0]?.changes[0]?.value?.messages[0]?.image?.caption ||
            "",
        },
      });
    }
    botWebhook(
      body?.entry[0]?.changes[0]?.value?.messages[0]?.image?.caption ||
        "aU1uLzohPGMncyrwlPIb",
      uid,
      body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id,
      body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA"
    );
  }

  // video
  else if (
    body?.entry[0]?.changes[0]?.value?.messages &&
    body?.entry[0]?.changes[0]?.value?.messages[0]?.video
  ) {
    const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);

    const metAPI = await query(`SELECT * FROM meta_api WHERE uid = ?`, [uid]);
    const metaToken = metAPI[0]?.access_token;

    if (metaToken) {
      const fileName = await downloadAndSaveMedia(
        metaToken,
        body?.entry[0]?.changes[0]?.value?.messages[0]?.video?.id
      );
      saveMessage(body, uid, "video", {
        type: "video",
        video: {
          link: `${process.env.FRONTENDURI}/meta-media/${fileName}`,
          caption:
            body?.entry[0]?.changes[0]?.value?.messages[0]?.video?.caption,
        },
      });
    }

    botWebhook(
      body?.entry[0]?.changes[0]?.value?.messages[0]?.video?.caption ||
        "aU1uLzohPGMncyrwlPIb",
      uid,
      body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id,
      body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA"
    );
  }

  // document
  else if (
    body?.entry[0]?.changes[0]?.value?.messages &&
    body?.entry[0]?.changes[0]?.value?.messages[0]?.document
  ) {
    const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);

    const metAPI = await query(`SELECT * FROM meta_api WHERE uid = ?`, [uid]);
    const metaToken = metAPI[0]?.access_token;

    if (metaToken) {
      const fileName = await downloadAndSaveMedia(
        metaToken,
        body?.entry[0]?.changes[0]?.value?.messages[0]?.document?.id
      );
      saveMessage(body, uid, "document", {
        type: "document",
        document: {
          link: `${process.env.FRONTENDURI}/meta-media/${fileName}`,
          caption:
            body?.entry[0]?.changes[0]?.value?.messages[0]?.document?.caption,
        },
      });
    }
    botWebhook(
      body?.entry[0]?.changes[0]?.value?.messages[0]?.document?.caption ||
        "aU1uLzohPGMncyrwlPIb",
      uid,
      body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id,
      body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA"
    );
  }

  // audio
  else if (
    body?.entry[0]?.changes[0]?.value?.messages &&
    body?.entry[0]?.changes[0]?.value?.messages[0]?.audio
  ) {
    const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);

    const metAPI = await query(`SELECT * FROM meta_api WHERE uid = ?`, [uid]);
    const metaToken = metAPI[0]?.access_token;

    if (metaToken) {
      const fileName = await downloadAndSaveMedia(
        metaToken,
        body?.entry[0]?.changes[0]?.value?.messages[0]?.audio?.id
      );
      saveMessage(body, uid, "audio", {
        type: "audio",
        audio: {
          link: `${process.env.FRONTENDURI}/meta-media/${fileName}`,
        },
      });
    }

    botWebhook(
      body?.entry[0]?.changes[0]?.value?.messages[0]?.document?.caption ||
        "aU1uLzohPGMncyrwlPIb",
      uid,
      body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id,
      body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA"
    );
  }

  // adding reactions
  else if (
    body?.entry[0]?.changes[0]?.value?.messages &&
    body?.entry[0]?.changes[0]?.value?.messages[0]?.reaction
  ) {
    const chatId = convertNumberToRandomString(
      body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id,
      body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA"
    );
    const filePath = `${__dirname}/../conversations/inbox/${uid}/${chatId}.json`;
    updateMessageObjectInFile(
      filePath,
      body?.entry[0]?.changes[0]?.value?.messages[0]?.reaction?.message_id,
      "reaction",
      body?.entry[0]?.changes[0]?.value?.messages[0]?.reaction?.emoji
    );

    const io = getIOInstance();

    const getId = await query(`SELECT * FROM rooms WHERE uid = ?`, [uid]);

    io.to(getId[0]?.socket_id).emit("push_new_reaction", {
      reaction: body?.entry[0]?.changes[0]?.value?.messages[0]?.reaction?.emoji,
      chatId: chatId,
      msgId:
        body?.entry[0]?.changes[0]?.value?.messages[0]?.reaction?.message_id,
    });

    // setting up for agent
    const getAgentChat = await query(
      `SELECT * FROM agent_chats WHERE owner_uid = ? AND chat_id = ?`,
      [uid, chatId]
    );

    if (getAgentChat.length > 0) {
      const getAgentSocket = await query(`SELECT * FROM rooms WHERE uid = ?`, [
        getAgentChat[0]?.uid,
      ]);

      io.to(getAgentSocket[0]?.socket_id).emit("push_new_reaction", {
        reaction:
          body?.entry[0]?.changes[0]?.value?.messages[0]?.reaction?.emoji,
        chatId: chatId,
        msgId:
          body?.entry[0]?.changes[0]?.value?.messages[0]?.reaction?.message_id,
      });
    }
  }

  // for button reply in tempelt message
  else if (
    body?.entry[0]?.changes[0]?.value?.messages &&
    body?.entry[0]?.changes[0]?.value?.messages[0]?.button?.text
  ) {
    saveMessage(body, uid, "text", {
      type: "text",
      text: {
        preview_url: true,
        body: body?.entry[0]?.changes[0]?.value?.messages[0]?.button?.text,
      },
    });

    botWebhook(
      body?.entry[0]?.changes[0]?.value?.messages[0]?.button?.text ||
        "aU1uLzohPGMncyrwlPIb",
      uid,
      body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id,
      body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA"
    );
  }

  // quick reply button
  else if (
    body?.entry[0]?.changes[0]?.value?.messages &&
    body?.entry[0]?.changes[0]?.value?.messages[0]?.interactive?.button_reply
  ) {
    saveMessage(body, uid, "text", {
      type: "text",
      text: {
        preview_url: true,
        body: body?.entry[0]?.changes[0]?.value?.messages[0]?.interactive
          ?.button_reply?.title,
      },
    });

    botWebhook(
      body?.entry[0]?.changes[0]?.value?.messages[0]?.interactive?.button_reply
        ?.title || "aU1uLzohPGMncyrwlPIb",
      uid,
      body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id,
      body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA"
    );
  }

  // updating delivery status
  else if (
    body?.entry[0]?.changes[0]?.value?.statuses &&
    body?.entry[0]?.changes[0]?.value?.statuses[0]?.id
  ) {
    const metaMsgId = body?.entry[0]?.changes[0]?.value?.statuses[0]?.id;

    // console.log(`update msg:-`, JSON.stringify(body))

    const chatId = convertNumberToRandomString(
      body?.entry[0]?.changes[0]?.value?.statuses[0]?.recipient_id,
      body?.entry[0]?.changes || "NA"
    );

    const filePath = `${__dirname}/../conversations/inbox/${uid}/${chatId}.json`;
    updateMessageObjectInFile(
      filePath,
      metaMsgId,
      "status",
      body?.entry[0]?.changes[0]?.value?.statuses[0]?.status
    );

    const io = getIOInstance();

    const getId = await query(`SELECT * FROM rooms WHERE uid = ?`, [uid]);

    io.to(getId[0]?.socket_id).emit("update_delivery_status", {
      chatId: chatId,
      status: body?.entry[0]?.changes[0]?.value?.statuses[0]?.status,
      msgId: body?.entry[0]?.changes[0]?.value?.statuses[0]?.id,
    });

    // setting up for agent
    const getAgentChat = await query(
      `SELECT * FROM agent_chats WHERE owner_uid = ? AND chat_id = ?`,
      [uid, chatId]
    );

    if (getAgentChat.length > 0) {
      const getAgentSocket = await query(`SELECT * FROM rooms WHERE uid = ?`, [
        getAgentChat[0]?.uid,
      ]);

      io.to(getAgentSocket[0]?.socket_id).emit("update_delivery_status", {
        chatId: chatId,
        status: body?.entry[0]?.changes[0]?.value?.statuses[0]?.status,
        msgId: body?.entry[0]?.changes[0]?.value?.statuses[0]?.id,
      });
    }

    if (body?.entry[0]?.changes[0]?.value?.statuses[0]?.status === "failed") {
      console.log({
        hey: JSON.stringify(
          body?.entry[0]?.changes[0]?.value?.statuses[0]?.errors[0]?.message
        ),
      });

      await query(
        `UPDATE broadcast_log SET delivery_status = ?, err = ? WHERE meta_msg_id = ?`,
        [
          body?.entry[0]?.changes[0]?.value?.statuses[0]?.status,
          JSON.stringify(body),
          metaMsgId,
        ]
      );
    } else {
      await query(
        `UPDATE broadcast_log SET delivery_status = ? WHERE meta_msg_id = ?`,
        [body?.entry[0]?.changes[0]?.value?.statuses[0]?.status, metaMsgId]
      );
    }
  }

  // list reply button
  else if (
    body?.entry[0]?.changes[0]?.value?.messages &&
    body?.entry[0]?.changes[0]?.value?.messages[0]?.interactive?.list_reply
  ) {
    saveMessage(body, uid, "text", {
      type: "text",
      text: {
        preview_url: true,
        body: body?.entry[0]?.changes[0]?.value?.messages[0]?.interactive
          ?.list_reply?.title,
      },
    });
    botWebhook(
      body?.entry[0]?.changes[0]?.value?.messages[0]?.interactive?.list_reply
        ?.title || "aU1uLzohPGMncyrwlPIb",
      uid,
      body?.entry[0]?.changes[0]?.value?.contacts[0]?.wa_id,
      body?.entry[0]?.changes
        ? body?.entry[0]?.changes[0]?.value?.contacts[0]?.profile?.name
        : "NA"
    );
  }
}

function updateMessageObjectInFile(filePath, metaChatId, key, value) {
  // Read JSON data from the file
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      console.error("Error reading file:", err);
      return;
    }

    try {
      // Parse JSON data
      const dataArray = JSON.parse(data);

      // Find the message object with the given metaChatId
      const message = dataArray.find((obj) => obj.metaChatId === metaChatId);

      // If the message is found, update the key with the new value
      if (message) {
        message[key] = value;
        console.log(
          `Updated message with metaChatId ${metaChatId}: ${key} set to ${value}`
        );

        // Write the modified JSON data back to the file
        fs.writeFile(
          filePath,
          JSON.stringify(dataArray, null, 2),
          "utf8",
          (err) => {
            if (err) {
              console.error("Error writing file:", err);
              return;
            }
            console.log("File updated successfully");
          }
        );
      } else {
        console.error(`Message with metaChatId ${metaChatId} not found`);
      }
    } catch (error) {
      console.error("Error parsing JSON:", error);
    }
  });
}

async function downloadAndSaveMedia(token, mediaId) {
  try {
    const url = `https://graph.facebook.com/v19.0/${mediaId}/`;
    // retriving url
    const getUrl = await axios(url, {
      headers: {
        Authorization: "Bearer " + token,
      },
    });

    const config = {
      method: "get",
      url: getUrl?.data?.url, //PASS THE URL HERE, WHICH YOU RECEIVED WITH THE HELP OF MEDIA ID
      headers: {
        Authorization: `Bearer ${token}`,
      },
      responseType: "arraybuffer",
    };

    const response = await axios(config);
    const ext = response.headers["content-type"].split("/")[1];

    const randomSt = randomstring.generate();
    const savingPath = `${__dirname}/../client/public/meta-media/${randomSt}`;
    fs.writeFileSync(`${savingPath}.${ext}`, response.data);
    return `${randomSt}.${ext}`;
  } catch (error) {
    console.error("Error downloading media:", error);
  }
}

function getCurrentTimestampInTimeZone(timezone) {
  const currentTimeInZone = moment.tz(timezone);
  const currentTimestampInSeconds = Math.round(
    currentTimeInZone.valueOf() / 1000
  );

  return currentTimestampInSeconds;
}

function addObjectToFile(object, filePath) {
  const parentDir = path.dirname(filePath);

  // Check if the parent directory exists
  if (!fs.existsSync(parentDir)) {
    // Create the parent directory if it doesn't exist
    fs.mkdirSync(parentDir, { recursive: true });
  }

  if (fs.existsSync(filePath)) {
    const existingData = JSON.parse(fs.readFileSync(filePath));
    if (Array.isArray(existingData)) {
      existingData.push(object);
      fs.writeFileSync(filePath, JSON.stringify(existingData, null, 2));
    } else {
      console.error("File does not contain an array.");
    }
  } else {
    fs.writeFileSync(filePath, JSON.stringify([object], null, 2));
  }
}

function convertNumberToRandomString(number) {
  const mapping = {
    0: "i",
    1: "j",
    2: "I",
    3: "u",
    4: "I",
    5: "U",
    6: "S",
    7: "D",
    8: "B",
    9: "j",
  };

  const numStr = number.toString();
  let result = "";
  for (let i = 0; i < numStr.length; i++) {
    const digit = numStr[i];
    result += mapping[digit];
  }
  return result;
}

function saveJsonToFile(jsonData, dir) {
  const timestamp = Date.now();
  const filename = `${timestamp}.json`;
  const jsonString = JSON.stringify(jsonData, null, 2); // null and 2 for pretty formatting
  const directory = dir; // Change this to your desired directory
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory);
  }
  const filePath = path.join(directory, filename);
  fs.writeFileSync(filePath, jsonString);
  console.log(`JSON data saved to ${filePath}`);
}

function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function areMobileNumbersFilled(array) {
  for (const item of array) {
    if (!item.mobile) {
      return false;
    }
  }

  return true;
}

function getFileExtension(fileName) {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex !== -1 && dotIndex !== 0) {
    const extension = fileName.substring(dotIndex + 1);
    return extension.toLowerCase();
  }
  return "";
}

function writeJsonToFile(filepath, jsonData, callback) {
  return new Promise((resolve, reject) => {
    // Ensure directory structure exists
    const directory = path.dirname(filepath);
    fs.mkdir(directory, { recursive: true }, function (err) {
      if (err) {
        if (callback) {
          callback(err);
        }
        reject(err);
        return;
      }

      // Convert JSON data to string
      const jsonString = JSON.stringify(jsonData, null, 2); // 2 spaces indentation for readability

      // Write JSON data to file, with 'w' flag to overwrite existing file
      fs.writeFile(filepath, jsonString, { flag: "w" }, function (err) {
        if (err) {
          if (callback) {
            callback(err);
          }
          reject(err);
          return;
        }
        const message = `JSON data has been written to '${filepath}'.`;
        if (callback) {
          callback(null, message);
        }
        resolve(message);
      });
    });
  });
}

function deleteFileIfExists(filePath) {
  // Check if the file exists
  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) {
      // File does not exist, do nothing
      console.error(`File ${filePath} does not exist.`);
      return;
    }

    // File exists, delete it
    fs.unlink(filePath, (err) => {
      if (err) {
        console.error(`Error deleting file ${filePath}:`, err);
        return;
      }
      console.log(`File ${filePath} has been deleted.`);
    });
  });
}

function readJsonFromFile(filePath) {
  try {
    // Read the file synchronously
    const jsonData = fs.readFileSync(filePath, "utf8");
    // Parse JSON data
    const parsedData = JSON.parse(jsonData);
    // If parsed data is an array, return it, otherwise return an empty array
    return Array.isArray(parsedData) ? parsedData : [];
  } catch (err) {
    // If any error occurs (e.g., file not found or invalid JSON), return an empty array
    console.error(`Error reading JSON file ${filePath}:`, err);
    return [];
  }
}

function readJSONFile(filePath, length) {
  try {
    console.log("HEY");
    // Check if the file exists
    if (!fs.existsSync(filePath)) {
      console.error("File not found:", filePath);
      return []; // Return empty array if file does not exist
    }

    // Read the file content
    let fileContent = fs.readFileSync(filePath, "utf8");

    // }\n]  }\n]

    if (fileContent?.endsWith("}\n]  }\n]")) {
      console.log("FOUND ENDS");
      console.log("Invalid JSON found, making it correct");
      fileContent = fileContent.replace("}\n]  }\n]", "\n}\n]");
      console.log("Correction done!");

      // Write the corrected JSON back to the file
      fs.writeFileSync(filePath, fileContent, "utf8");
      console.log("Corrected JSON has been written to the file");
    }

    // Remove invalid trailing characters if they exist
    if (fileContent?.endsWith("}\n]\n}\n]")) {
      console.log("FOUND ENDS");
      console.log("Invalid JSON found, making it correct");
      fileContent = fileContent.replace("}\n]\n}\n]", "\n}\n]");
      console.log("Correction done!");

      // Write the corrected JSON back to the file
      fs.writeFileSync(filePath, fileContent, "utf8");
      console.log("Corrected JSON has been written to the file");
    }

    // Try to parse the JSON
    let jsonArray;
    try {
      jsonArray = JSON.parse(fileContent);
    } catch (error) {
      console.error("Initial JSON parse error:", error.message);
      return []; // Return empty array if JSON is not valid
    }

    // Check if the parsed content is an array
    if (!Array.isArray(jsonArray)) {
      console.error("Invalid JSON format: not an array");
      return []; // Return empty array if JSON is not an array
    }

    // If length is provided, return only specified number of latest objects
    if (typeof length === "number" && length > 0) {
      return jsonArray.slice(-length);
    }

    return jsonArray; // Return all objects if length is not provided or invalid
  } catch (error) {
    console.error("Error reading JSON file:", error);
    return []; // Return empty array if there's an error
  }
}

function updateMetaTempletInMsg(uid, savObj, chatId, msgId) {
  return new Promise(async (resolve, reject) => {
    try {
      console.log({ thisss: uid });
      const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);

      if (getUser.length < 1) {
        return resolve({ success: false, msg: "user not found" });
      }

      const userTimezone = getCurrentTimestampInTimeZone(
        getUser[0]?.timezone || Date.now() / 1000
      );
      const finalSaveMsg = {
        ...savObj,
        metaChatId: msgId,
        timestamp: userTimezone,
      };

      const chatPath = `${__dirname}/../conversations/inbox/${uid}/${chatId}.json`;
      addObjectToFile(finalSaveMsg, chatPath);

      const io = getIOInstance();

      await query(
        `UPDATE chats SET last_message_came = ?, last_message = ?, is_opened = ? WHERE chat_id = ?`,
        [userTimezone, JSON.stringify(savObj), 0, chatId]
      );

      const getId = await query(`SELECT * FROM rooms WHERE uid = ?`, [uid]);

      await query(`UPDATE chats SET is_opened = ? WHERE chat_id = ?`, [
        1,
        chatId,
      ]);

      const chats = await query(`SELECT * FROM chats WHERE uid = ?`, [uid]);

      io.to(getId[0]?.socket_id).emit("update_conversations", {
        chats: chats,
        notificationOff: true,
      });

      io.to(getId[0]?.socket_id).emit("push_new_msg", {
        msg: finalSaveMsg,
        chatId: chatId,
      });

      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

function sendAPIMessage(obj, waNumId, waToken) {
  return new Promise(async (resolve) => {
    try {
      const url = `https://graph.facebook.com/v17.0/${waNumId}/messages`;

      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        ...obj,
      };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${waToken}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (data?.error) {
        return resolve({ success: false, message: data?.error?.message });
      }

      resolve({
        success: true,
        message: "Message sent successfully!",
        data: data?.messages[0],
      });
    } catch (err) {
      resolve({ success: false, msg: err.toString(), err });
      console.log(err);
    }
  });
}

function sendMetaMsg(uid, msgObj, toNumber, savObj, chatId) {
  return new Promise(async (resolve) => {
    try {
      const getMeta = await query(`SELECT * FROM meta_api WHERE uid = ?`, [
        uid,
      ]);
      const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);

      if (getMeta.length < 1) {
        return resolve({ success: false, msg: "Unable to to find API " });
      }

      const waToken = getMeta[0]?.access_token;
      const waNumId = getMeta[0]?.business_phone_number_id;

      if (!waToken || !waNumId) {
        return resolve({
          success: false,
          msg: "Please add your meta token and phone number ID",
        });
      }

      const url = `https://graph.facebook.com/v17.0/${waNumId}/messages`;

      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: toNumber,
        ...msgObj,
      };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${waToken}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (data?.error) {
        return resolve({ success: false, msg: data?.error?.message });
      }

      if (data?.messages[0]?.id) {
        const userTimezone = getCurrentTimestampInTimeZone(
          getUser[0]?.timezone || Date.now() / 1000
        );
        const finalSaveMsg = {
          ...savObj,
          metaChatId: data?.messages[0]?.id,
          timestamp: userTimezone,
        };

        const chatPath = `${__dirname}/../conversations/inbox/${uid}/${chatId}.json`;
        addObjectToFile(finalSaveMsg, chatPath);

        await query(
          `UPDATE chats SET last_message_came = ?, last_message = ?, is_opened = ? WHERE chat_id = ?`,
          [userTimezone, JSON.stringify(finalSaveMsg), 1, chatId]
        );

        await query(`UPDATE chats SET is_opened = ? WHERE chat_id = ?`, [
          1,
          chatId,
        ]);
      }

      resolve({ success: true });
    } catch (err) {
      resolve({ success: false, msg: err.toString(), err });
      console.log(err);
    }
  });
}

function mergeArrays(arrA, arrB) {
  const mergedArray = arrB.map((objB) => {
    const matchingObject = arrA.find(
      (objA) => objA.mobile === objB.sender_mobile
    );
    if (matchingObject) {
      return { ...objB, contact: matchingObject };
    }
    return objB;
  });

  return mergedArray;
}

async function getBusinessPhoneNumber(
  apiVersion,
  businessPhoneNumberId,
  bearerToken
) {
  const url = `https://graph.facebook.com/${apiVersion}/${businessPhoneNumberId}`;
  const options = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
    },
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error; // Re-throw the error to handle it upstream
  }
}

async function createMetaTemplet(apiVersion, waba_id, bearerToken, body) {
  const url = `https://graph.facebook.com/${apiVersion}/${waba_id}/message_templates`;
  const options = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body), // Include the request body here
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error; // Re-throw the error to handle it upstream
  }
}

async function getAllTempletsMeta(apiVersion, waba_id, bearerToken) {
  const url = `https://graph.facebook.com/${apiVersion}/${waba_id}/message_templates`;
  const options = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
    },
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error; // Re-throw the error to handle it upstream
  }
}

async function delMetaTemplet(apiVersion, waba_id, bearerToken, name) {
  const url = `https://graph.facebook.com/${apiVersion}/${waba_id}/message_templates?name=${name}`;
  const options = {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
    },
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error; // Re-throw the error to handle it upstream
  }
}

async function sendMetatemplet(
  toNumber,
  business_phone_number_id,
  token,
  template,
  example,
  dynamicMedia
) {
  const checkBody = template?.components?.filter((i) => i.type === "BODY");
  const getHeader = template?.components?.filter((i) => i.type === "HEADER");
  const headerFormat = getHeader.length > 0 ? getHeader[0]?.format : "";

  let templ = {
    name: template?.name,
    language: {
      code: template?.language,
    },
    components: [],
  };

  if (checkBody.length > 0) {
    const comp = checkBody[0]?.example?.body_text[0]?.map((i, key) => ({
      type: "text",
      text: example[key] || i,
    }));
    if (comp) {
      templ.components.push({
        type: "body",
        parameters: comp,
      });
    }
  }

  if (headerFormat === "IMAGE" && getHeader.length > 0) {
    const getMedia = await query(
      `SELECT * FROM meta_templet_media WHERE templet_name = ?`,
      [template?.name]
    );

    templ.components.unshift({
      type: "header",
      parameters: [
        {
          type: "image",
          image: {
            link: dynamicMedia
              ? dynamicMedia
              : getMedia.length > 0
              ? `${process.env.FRONTENDURI}/media/${getMedia[0]?.file_name}`
              : getHeader[0].example?.header_handle[0],
          },
        },
      ],
    });
  }

  if (headerFormat === "VIDEO" && getHeader.length > 0) {
    const getMedia = await query(
      `SELECT * FROM meta_templet_media WHERE templet_name = ?`,
      [template?.name]
    );

    templ.components.unshift({
      type: "header",
      parameters: [
        {
          type: "video",
          video: {
            link: dynamicMedia
              ? dynamicMedia
              : getMedia.length > 0
              ? `${process.env.FRONTENDURI}/media/${getMedia[0]?.file_name}`
              : getHeader[0].example?.header_handle[0],
          },
        },
      ],
    });
  }

  if (headerFormat === "DOCUMENT" && getHeader.length > 0) {
    const getMedia = await query(
      `SELECT * FROM meta_templet_media WHERE templet_name = ?`,
      [template?.name]
    );

    templ.components.unshift({
      type: "header",
      parameters: [
        {
          type: "document",
          document: {
            link: dynamicMedia
              ? dynamicMedia
              : getMedia.length > 0
              ? `${process.env.FRONTENDURI}/media/${getMedia[0]?.file_name}`
              : getHeader[0].example?.header_handle[0],
            filename: "document",
          },
        },
      ],
    });
  }

  const url = `https://graph.facebook.com/v18.0/${business_phone_number_id}/messages`;

  // console.log({ templ: JSON.stringify(templ) })

  const body = {
    messaging_product: "whatsapp",
    to: toNumber,
    type: "template",
    template: templ,
  };

  const options = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    // console.log({ data: JSON.stringify(data) });
    // console.log({ body: JSON.stringify(body) });
    // console.log({ data })
    return data;
  } catch (error) {
    console.error("Error sending message:", error);
    throw error;
  }
}

function getFileInfo(filePath) {
  return new Promise((resolve, reject) => {
    fs.stat(filePath, (err, stats) => {
      if (err) {
        reject(err);
      } else {
        const fileSizeInBytes = stats.size;
        const mimeType = mime.lookup(filePath) || "application/octet-stream";
        resolve({ fileSizeInBytes, mimeType });
      }
    });
  });
}

async function getSessionUploadMediaMeta(
  apiVersion,
  app_id,
  bearerToken,
  fileSize,
  mimeType
) {
  const url = `https://graph.facebook.com/${apiVersion}/${app_id}/uploads?file_length=${fileSize}&file_type=${mimeType}`;
  const options = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
    },
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error; // Re-throw the error to handle it upstream
  }
}

async function uploadFileMeta(sessionId, filePath, apiVersion, accessToken) {
  return new Promise(async (resolve) => {
    try {
      // Read the file as binary data
      const fileData = fs.readFileSync(filePath);

      // Prepare URL
      const url = `https://graph.facebook.com/${apiVersion}/${sessionId}`;

      // Prepare options for fetch
      const options = {
        method: "POST",
        headers: {
          Authorization: `OAuth ${accessToken}`,
          "Content-Type": "application/pdf",
          Cookie: "ps_l=0; ps_n=0",
        },
        body: fileData,
      };

      // Make fetch request
      const response = await fetch(url, options);
      if (!response.ok) {
        const errorResponse = await response.json(); // Parse error response as JSON
        console.error("Error response:", errorResponse);
        return resolve({ success: false, data: errorResponse });
      }
      const data = await response.json();
      return resolve({ success: true, data });
    } catch (error) {
      return resolve({ success: false, data: error });
    }
  });
}

async function getMetaNumberDetail(
  apiVersion,
  budiness_phone_number_id,
  bearerToken
) {
  const url = `https://graph.facebook.com/${apiVersion}/${budiness_phone_number_id}`;
  const options = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/json",
    },
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error; // Re-throw the error to handle it upstream
  }
}

function addDaysToCurrentTimestamp(days) {
  // Get the current timestamp
  let currentTimestamp = Date.now();

  // Calculate the milliseconds for the given number of days
  let millisecondsToAdd = days * 24 * 60 * 60 * 1000;

  // Add the milliseconds to the current timestamp
  let newTimestamp = currentTimestamp + millisecondsToAdd;

  // Return the new timestamp
  return newTimestamp;
}

// update user plan
async function updateUserPlan(plan, uid) {
  console.log({ plan });
  const planDays = parseInt(plan?.plan_duration_in_days || 0);
  const timeStamp = addDaysToCurrentTimestamp(planDays);
  await query(`UPDATE user SET plan = ?, plan_expire = ? WHERE uid = ?`, [
    JSON.stringify(plan),
    timeStamp,
    uid,
  ]);
}

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).toLowerCase());
}

async function sendEmailBeta(config) {
  try {
    const {
      host,
      port,
      email,
      pass,
      username,
      from,
      to,
      subject,
      html,
      security,
      useAuth,
    } = config;

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // Use true for port 465 (SSL), false for 587 (TLS)
      auth: useAuth
        ? {
            user: username,
            pass: pass,
          }
        : undefined,
      tls: security === "tls" ? { rejectUnauthorized: false } : undefined,
    });

    const info = await transporter.sendMail({
      from,
      to,
      subject,
      html,
    });

    return { success: true, messageId: info.messageId };
  } catch (err) {
    return { success: false, msg: err.message };
  }
}

function sendEmail(host, port, email, pass, html, subject, from, to, username) {
  console.log({
    host,
    port,
    email,
    pass,
  });
  return new Promise(async (resolve) => {
    try {
      let transporter = nodemailer.createTransport({
        host: host,
        port: port,
        secure: port === "465" ? true : false, // true for 465, false for other ports
        auth: {
          user: username || email, // generated ethereal user
          pass: pass, // generated ethereal password
        },
      });

      let info = await transporter.sendMail({
        from: `${from || "Email From"} <${email}>`, // sender address
        to: to, // list of receivers
        subject: subject || "Email", // Subject line
        html: html, // html body
      });

      resolve({ success: true, info });
    } catch (err) {
      resolve({ success: false, err: err.toString() || "Invalid Email" });
    }
  });
}

function getUserSignupsByMonth(users) {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();

  // Filter users into paid and unpaid arrays
  const { paidUsers, unpaidUsers } = users.reduce(
    (acc, user) => {
      const planExpire = user.plan_expire
        ? new Date(parseInt(user.plan_expire))
        : null;
      const isPaid = planExpire ? planExpire > currentDate : false;
      if (isPaid) {
        acc.paidUsers.push(user);
      } else {
        acc.unpaidUsers.push(user);
      }
      return acc;
    },
    { paidUsers: [], unpaidUsers: [] }
  );

  // Create signups by month for paid users
  const paidSignupsByMonth = months.map((month, monthIndex) => {
    const usersInMonth = paidUsers.filter((user) => {
      const userDate = new Date(user.createdAt);
      return (
        userDate.getMonth() === monthIndex &&
        userDate.getFullYear() === currentYear
      );
    });
    const numberOfSignups = usersInMonth.length;
    const userEmails = usersInMonth.map((user) => user.email);
    return { month, numberOfSignups, userEmails, paid: true };
  });

  // Create signups by month for unpaid users
  const unpaidSignupsByMonth = months.map((month, monthIndex) => {
    const usersInMonth = unpaidUsers.filter((user) => {
      const userDate = new Date(user.createdAt);
      return (
        userDate.getMonth() === monthIndex &&
        userDate.getFullYear() === currentYear
      );
    });
    const numberOfSignups = usersInMonth.length;
    const userEmails = usersInMonth.map((user) => user.email);
    return { month, numberOfSignups, userEmails, paid: false };
  });

  return { paidSignupsByMonth, unpaidSignupsByMonth };
}

function getUserOrderssByMonth(orders) {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const signupsByMonth = Array.from({ length: 12 }, (_, monthIndex) => {
    const month = months[monthIndex];
    const ordersInMonth = orders.filter((user) => {
      const userDate = new Date(user.createdAt);
      return (
        userDate.getMonth() === monthIndex &&
        userDate.getFullYear() === currentYear
      );
    });
    const numberOfOders = ordersInMonth.length;
    return { month, numberOfOders };
  });
  return signupsByMonth;
}

function getNumberOfDaysFromTimestamp(timestamp) {
  if (!timestamp || isNaN(timestamp)) {
    return 0; // Invalid timestamp
  }

  const currentTimestamp = Date.now();
  if (timestamp <= currentTimestamp) {
    return 0; // Timestamp is in the past or current time
  }

  const millisecondsInADay = 1000 * 60 * 60 * 24;
  const differenceInDays = Math.ceil(
    (timestamp - currentTimestamp) / millisecondsInADay
  );
  return differenceInDays;
}

async function getUserPlayDays(uid) {
  const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);
  if (getUser.length < 1) {
    return 0;
  }
  if (!getUser[0].plan_expire) {
    return 0;
  } else {
    const days = getNumberOfDaysFromTimestamp(getUser[0]?.plan_expire);
    return days;
  }
}

function folderExists(folderPath) {
  try {
    // Check if the folder exists/Users/hamidsaifi/Desktop/projects/wa-crm-doc/client/public/logo192.png /Users/hamidsaifi/Desktop/projects/wa-crm-doc/client/public/logo512.png
    fs.accessSync(folderPath, fs.constants.F_OK);
    return true;
  } catch (error) {
    // Folder does not exist or inaccessible
    return false;
  }
}

async function downloadAndExtractFile(filesObject, outputFolderPath) {
  try {
    // Access the uploaded file from req.files
    const uploadedFile = filesObject.file;
    if (!uploadedFile) {
      return { success: false, msg: "No file data found in FormData" };
    }

    // Create a writable stream to save the file
    const outputPath = path.join(outputFolderPath, uploadedFile.name);

    // Move the file to the desired location
    await new Promise((resolve, reject) => {
      uploadedFile.mv(outputPath, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    // Extract the downloaded file
    await fs
      .createReadStream(outputPath)
      .pipe(unzipper.Extract({ path: outputFolderPath })) // Specify the output folder path for extraction
      .promise();

    // Delete the downloaded zip file after extraction
    fs.unlinkSync(outputPath);

    return { success: true, msg: "App was successfully installed/updated" };
  } catch (error) {
    console.error("Error downloading and extracting file:", error);
    return { success: false, msg: error.message };
  }
}

function fetchProfileFun(mobileId, token) {
  return new Promise(async (resolve, reject) => {
    try {
      const response = await fetch(
        `https://graph.facebook.com/v17.0/${mobileId}`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          // body: JSON.stringify(payload)
        }
      );

      const data = await response.json();

      if (data.error) {
        return resolve({ success: false, msg: data.error?.message });
      } else {
        return resolve({ success: true, data: data });
      }
    } catch (error) {
      console.log({ error });
      reject(error);
    }
  });
}

function returnWidget(image, imageSize, url, position) {
  let style = "";
  switch (position) {
    case "TOP_RIGHT":
      style = "position: fixed; top: 15px; right: 15px;";
      break;
    case "TOP_CENTER":
      style =
        "position: fixed; top: 15px; right: 50%; transform: translateX(-50%);";
      break;
    case "TOP_LEFT":
      style = "position: fixed; top: 15px; left: 15px;";
      break;
    case "BOTTOM_RIGHT":
      style = "position: fixed; bottom: 15px; right: 15px;";
      break;
    case "BOTTOM_CENTER":
      style =
        "position: fixed; bottom: 15px; right: 50%; transform: translateX(-50%);";
      break;
    case "BOTTOM_LEFT":
      style = "position: fixed; bottom: 15px; left: 15px;";
      break;
    case "ALL_CENTER":
      style =
        "position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);";
      break;
    default:
      // Default position is top right
      style = "position: fixed; top: 15px; right: 15px;";
      break;
  }

  return `
    <a href="${url}">
      <img  src="${image}" alt="Widget" id="widget-image"
        style="${style} width: ${imageSize}px; height: auto; cursor: pointer; z-index: 9999;">
        </a>
      <!-- Widget content -->

      <div  class="widget-container" id="widget-container"
        style="position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background-color: #fff; border: 1px solid #ccc; border-radius: 5px; padding: 10px; box-shadow: 0px 2px 5px rgba(0, 0, 0, 0.1); display: none; z-index: 9999;">
        <span class="close-btn" id="close-btn"
          style="position: absolute; top: 5px; right: 5px; cursor: pointer;">&times;</span>
      </div>

      
  
      <script>
        // Get references to the image and widget container
        const widgetImage = document.getElementById('widget-image');
        const widgetContainer = document.getElementById('widget-container');
  
        // Redirect to a URL when the image is clicked
        widgetImage.addEventListener('click', function () {
          // Replace '${url} with the desired URL
          window.location.href = '${url}';
        });
  
        // Close widget when close button is clicked
        const closeBtn = document.getElementById('close-btn');
        closeBtn.addEventListener('click', function (event) {
          event.stopPropagation(); // Prevents the click event from propagating to the widget image
          widgetContainer.style.display = 'none';
        });
      </script>
    `;
}

function generateWhatsAppURL(phoneNumber, text) {
  const baseUrl = "https://wa.me/";
  const formattedPhoneNumber = phoneNumber.replace(/\D/g, ""); // Remove non-numeric characters
  const encodedText = encodeURIComponent(text);
  return `${baseUrl}${formattedPhoneNumber}?text=${encodedText}`;
}

async function makeRequest({ method, url, body = null, headers = [] }) {
  try {
    // Create an AbortController to handle the timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // 20 seconds

    // Convert headers array to an object
    const headersObject = headers.reduce((acc, { key, value }) => {
      acc[key] = value;
      return acc;
    }, {});

    // Set Content-Type to application/json for POST and PUT methods
    if (method === "POST" || method === "PUT") {
      headersObject["Content-Type"] = "application/json";
    }

    // Convert body array to an object if it's not GET or DELETE
    const requestBody =
      method === "GET" || method === "DELETE"
        ? undefined
        : JSON.stringify(
            body.reduce((acc, { key, value }) => {
              acc[key] = value;
              return acc;
            }, {})
          );

    // Set up the request configuration
    const config = {
      method,
      headers: headersObject,
      body: requestBody,
      signal: controller.signal,
    };

    console.log({
      config,
    });

    // Perform the request
    const response = await fetch(url, config);

    // Clear the timeout
    clearTimeout(timeoutId);

    // Check if the response status is OK
    if (!response.ok) {
      return { success: false, msg: `HTTP error ${response.status}` };
    }

    // Parse the response
    const data = await response.json();

    // Validate the response
    if (typeof data === "object" || Array.isArray(data)) {
      return { success: true, data };
    } else {
      return { success: false, msg: "Invalid response format" };
    }
  } catch (error) {
    // Handle errors (e.g., timeout, network issues)
    return { success: false, msg: error.message };
  }
}

function replacePlaceholders(template, data) {
  return template.replace(/{{{([^}]+)}}}/g, (match, key) => {
    // Remove any whitespace and parse the key
    key = key.trim();

    // Handle array indexing
    const arrayMatch = key.match(/^\[(\d+)]\.(.+)$/);
    if (arrayMatch) {
      const index = parseInt(arrayMatch[1], 10);
      const property = arrayMatch[2];

      if (Array.isArray(data) && index >= 0 && index < data.length) {
        let value = data[index];
        // Split the property string for nested properties
        const nestedKeys = property.split(".");
        for (const k of nestedKeys) {
          if (value && Object.prototype.hasOwnProperty.call(value, k)) {
            value = value[k];
          } else {
            return "NA";
          }
        }
        return value !== undefined ? value : "NA";
      } else {
        return "NA";
      }
    }

    // Handle object properties
    const keys = key.split("."); // Support for nested keys
    let value = data;

    for (const k of keys) {
      if (value && Object.prototype.hasOwnProperty.call(value, k)) {
        value = value[k];
      } else {
        return "NA"; // Return 'NA' if key is not found in the object
      }
    }

    return value !== undefined ? value : "NA"; // Return 'NA' if value is undefined
  });
}

const rzCapturePayment = (paymentId, amount, razorpayKey, razorpaySecret) => {
  // Disable SSL certificate validation
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const auth =
    "Basic " +
    Buffer.from(razorpayKey + ":" + razorpaySecret).toString("base64");

  return new Promise((resolve, reject) => {
    fetch(`https://api.razorpay.com/v1/payments/${paymentId}/capture`, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ amount: amount }), // Replace with the actual amount to capture
    })
      .then((response) => response.json())
      .then((data) => {
        if (data.error) {
          console.error("Error capturing payment:", data.error);
          reject(data.error);
        } else {
          console.log("Payment captured successfully:", data);
          resolve(data);
        }
      })
      .catch((error) => {
        console.error("Error capturing payment:", error);
        reject(error);
      });
  });
};

async function validateFacebookToken(userAccessToken, appId, appSecret) {
  // Construct the app access token by combining App ID and App Secret
  const appAccessToken = `${appId}|${appSecret}`;

  // Define the Facebook Graph API URL for debugging tokens
  const url = `https://graph.facebook.com/debug_token?input_token=${userAccessToken}&access_token=${appAccessToken}`;

  try {
    // Fetch the response from the Facebook Graph API
    const response = await fetch(url);

    // Parse the JSON response
    const data = await response.json();

    // Check if the token is valid
    if (data.data && data.data.is_valid) {
      // Token is valid
      return { success: true, response: data };
    } else {
      // Token is not valid
      return { success: false, response: data };
    }
  } catch (error) {
    // Handle any errors that occur during the fetch operation
    console.error("Error validating Facebook token:", error);
    return { success: false, response: error };
  }
}

function extractFileName(url) {
  try {
    const decodedUrl = decodeURIComponent(url.split("?")[0]); // Remove query params
    return decodedUrl.substring(decodedUrl.lastIndexOf("/") + 1);
  } catch (error) {
    console.error("Error extracting file name:", error.message);
    return null;
  }
}

async function checkWarmerPlan({ uid }) {
  try {
    const [user] = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);
    const warmer = user?.plan ? JSON.parse(user?.plan)?.wa_warmer : 0;
    return parseInt(warmer) > 0 ? true : false;
  } catch (err) {
    return false;
  }
}

async function getAllTempletsMetaBeta(
  apiVersion,
  waba_id,
  bearerToken,
  limit = 9,
  after = null,
  before = null,
  status = "APPROVED"
) {
  let url = `https://graph.facebook.com/${apiVersion}/${waba_id}/message_templates?limit=${limit}&status=${status}`;

  // Add cursor parameters if provided
  if (after) {
    url += `&after=${after}`;
  } else if (before) {
    url += `&before=${before}`;
  }

  const options = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
    },
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
}

// Helper function to extract variables from a template
function extractTemplateVariablesBeta(template) {
  const variables = [];

  // Check components for variables
  if (template.components) {
    template.components.forEach((component) => {
      // Check body component for variables
      if (component.type === "BODY" && component.text) {
        const matches = component.text.match(/{{(\d+)}}/g) || [];
        matches.forEach((match) => {
          const varNumber = match.replace("{{", "").replace("}}", "");
          variables.push({
            component: "BODY",
            index: varNumber,
            example:
              component.example?.body_text?.[Number(varNumber) - 1] || "",
          });
        });
      }

      // Check header for media variables
      if (component.type === "HEADER" && component.format !== "TEXT") {
        variables.push({
          component: "HEADER",
          type: component.format.toLowerCase(),
          example: component.example?.header_handle?.[0] || "",
        });
      }

      // Check buttons for variables
      if (component.type === "BUTTONS" && component.buttons) {
        component.buttons.forEach((button, idx) => {
          if (button.type === "URL" && button.url.includes("{{")) {
            variables.push({
              component: "BUTTON",
              index: idx,
              buttonType: "URL",
              example: button.example || "",
            });
          }
        });
      }
    });
  }

  return variables;
}

// Helper function to format phone number
function formatPhoneNumber(phone) {
  // Remove any non-digit characters
  let cleaned = phone.replace(/\D/g, "");

  // Ensure it has country code (add default 1 for US if needed)
  if (cleaned.length === 10) {
    cleaned = "1" + cleaned;
  }

  // Add + prefix if not present
  if (!cleaned.startsWith("+")) {
    cleaned = "+" + cleaned;
  }

  return cleaned;
}

// Function to send template message
async function sendTemplateMessage(
  apiVersion,
  phoneNumberId,
  accessToken,
  templateName,
  language,
  recipientPhone,
  bodyVariables = [],
  headerVariable = null,
  buttonVariables = []
) {
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  // Prepare the message payload
  const messagePayload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipientPhone,
    type: "template",
    template: {
      name: templateName,
      language: {
        code: language,
      },
      components: [],
    },
  };

  // Add body component with variables if provided
  if (bodyVariables && bodyVariables.length > 0) {
    const bodyComponent = {
      type: "body",
      parameters: bodyVariables.map((variable) => {
        return {
          type: "text",
          text: variable,
        };
      }),
    };
    messagePayload.template.components.push(bodyComponent);
  }

  // Add header component with variable if provided
  if (headerVariable) {
    const headerComponent = {
      type: "header",
      parameters: [],
    };

    // Determine header variable type
    if (headerVariable.type === "image") {
      headerComponent.parameters.push({
        type: "image",
        image: {
          link: headerVariable.url,
        },
      });
    } else if (headerVariable.type === "document") {
      headerComponent.parameters.push({
        type: "document",
        document: {
          link: headerVariable.url,
          filename: headerVariable.filename || "document",
        },
      });
    } else if (headerVariable.type === "video") {
      headerComponent.parameters.push({
        type: "video",
        video: {
          link: headerVariable.url,
        },
      });
    }

    messagePayload.template.components.push(headerComponent);
  }

  // Add button variables if provided
  if (buttonVariables && buttonVariables.length > 0) {
    buttonVariables.forEach((buttonVar, index) => {
      if (buttonVar.value) {
        const buttonComponent = {
          type: "button",
          sub_type: "url",
          index: buttonVar.index.toString(),
          parameters: [
            {
              type: "text",
              text: buttonVar.value,
            },
          ],
        };

        messagePayload.template.components.push(buttonComponent);
      }
    });
  }

  // Send the request
  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(messagePayload),
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error sending template message:", error);
    throw error;
  }
}

// Helper function to get recent messages for context
async function getRecentMessages(chatId, uid, limit = 5) {
  try {
    const messages = await query(
      `SELECT * FROM beta_conversation 
       WHERE chat_id = ? AND uid = ? 
       ORDER BY timestamp DESC LIMIT ?`,
      [chatId, uid, limit]
    );

    return messages
      .map((msg) => {
        try {
          const parsedContext = msg.msgContext
            ? JSON.parse(msg.msgContext)
            : {};
          return {
            type: msg.type,
            text: parsedContext.text?.body || "",
            route: msg.route,
            timestamp: msg.timestamp,
          };
        } catch (e) {
          return {
            type: msg.type,
            text: "",
            route: msg.route,
            timestamp: msg.timestamp,
          };
        }
      })
      .reverse(); // Return in chronological order
  } catch (error) {
    console.error("Error fetching recent messages:", error);
    return [];
  }
}

async function suggestReplyWithOpenAI(messages, lastMessage, apiKey) {
  try {
    // Format conversation history
    const formattedMessages = messages.map((msg) => ({
      role: msg.route === "INCOMING" ? "user" : "assistant",
      content: msg.text,
    }));

    // Add system message at the beginning
    formattedMessages.unshift({
      role: "system",
      content:
        "You are a helpful assistant. Generate a concise, natural-sounding reply to the conversation. The reply should be friendly, helpful, and appropriate for a business conversation. Only return the suggested reply without explanations.",
    });
    if (lastMessage) {
      formattedMessages.push({
        role: "user",
        content: lastMessage,
      });
    }

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages: formattedMessages,
        temperature: 0.7,
        max_tokens: 500,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error(
      "OpenAI suggestion error:",
      error.response?.data || error.message
    );
    throw new Error(
      error.response?.data?.error?.message || "OpenAI suggestion failed"
    );
  }
}

async function suggestReplyWithGemini(messages, lastMessage, apiKey) {
  try {
    // Format conversation history
    let conversationText = "Here is the conversation history:\n\n";

    messages.forEach((msg) => {
      const role = msg.route === "INCOMING" ? "Customer" : "Support";
      conversationText += `${role}: ${msg.text}\n`;
    });

    // Add the latest message if provided
    if (lastMessage) {
      conversationText += `Customer: ${lastMessage}\n`;
    }

    conversationText +=
      "\nGenerate a concise, natural-sounding reply from Support. The reply should be friendly, helpful, and appropriate for a business conversation. Only return the suggested reply without explanations.";

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`,
      {
        contents: [
          {
            parts: [
              {
                text: conversationText,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 500,
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.candidates[0].content.parts[0].text.trim();
  } catch (error) {
    console.error(
      "Gemini suggestion error:",
      error.response?.data || error.message
    );
    throw new Error(
      error.response?.data?.error?.message || "Gemini suggestion failed"
    );
  }
}

async function suggestReplyWithDeepseek(messages, lastMessage, apiKey) {
  try {
    // Format conversation history
    const formattedMessages = messages.map((msg) => ({
      role: msg.route === "INCOMING" ? "user" : "assistant",
      content: msg.text,
    }));

    // Add system message at the beginning
    formattedMessages.unshift({
      role: "system",
      content:
        "You are a helpful assistant. Generate a concise, natural-sounding reply to the conversation. The reply should be friendly, helpful, and appropriate for a business conversation. Only return the suggested reply without explanations.",
    });

    // Add the latest message if provided
    if (lastMessage) {
      formattedMessages.push({
        role: "user",
        content: lastMessage,
      });
    }

    const response = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages: formattedMessages,
        temperature: 0.7,
        max_tokens: 500,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error(
      "Deepseek suggestion error:",
      error.response?.data || error.message
    );
    throw new Error(
      error.response?.data?.error?.message || "Deepseek suggestion failed"
    );
  }
}

const languageNames = [
  { code: "af", name: "Afrikaans" },
  { code: "am", name: "Amharic" },
  { code: "ar", name: "Arabic" },
  { code: "az", name: "Azerbaijani" },
  { code: "be", name: "Belarusian" },
  { code: "bg", name: "Bulgarian" },
  { code: "bn", name: "Bengali" },
  { code: "bs", name: "Bosnian" },
  { code: "ca", name: "Catalan" },
  { code: "ceb", name: "Cebuano" },
  { code: "cs", name: "Czech" },
  { code: "cy", name: "Welsh" },
  { code: "da", name: "Danish" },
  { code: "de", name: "German" },
  { code: "el", name: "Greek" },
  { code: "en", name: "English" },
  { code: "eo", name: "Esperanto" },
  { code: "es", name: "Spanish" },
  { code: "et", name: "Estonian" },
  { code: "eu", name: "Basque" },
  { code: "fa", name: "Persian" },
  { code: "fi", name: "Finnish" },
  { code: "fr", name: "French" },
  { code: "fy", name: "Frisian" },
  { code: "ga", name: "Irish" },
  { code: "gd", name: "Scottish Gaelic" },
  { code: "gl", name: "Galician" },
  { code: "gu", name: "Gujarati" },
  { code: "ha", name: "Hausa" },
  { code: "haw", name: "Hawaiian" },
  { code: "he", name: "Hebrew" },
  { code: "hi", name: "Hindi" },
  { code: "hmn", name: "Hmong" },
  { code: "hr", name: "Croatian" },
  { code: "ht", name: "Haitian Creole" },
  { code: "hu", name: "Hungarian" },
  { code: "hy", name: "Armenian" },
  { code: "id", name: "Indonesian" },
  { code: "ig", name: "Igbo" },
  { code: "is", name: "Icelandic" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "jw", name: "Javanese" },
  { code: "ka", name: "Georgian" },
  { code: "kk", name: "Kazakh" },
  { code: "km", name: "Khmer" },
  { code: "kn", name: "Kannada" },
  { code: "ko", name: "Korean" },
  { code: "ku", name: "Kurdish" },
  { code: "ky", name: "Kyrgyz" },
  { code: "la", name: "Latin" },
  { code: "lo", name: "Lao" },
  { code: "lt", name: "Lithuanian" },
  { code: "lv", name: "Latvian" },
  { code: "mg", name: "Malagasy" },
  { code: "mi", name: "Maori" },
  { code: "mk", name: "Macedonian" },
  { code: "ml", name: "Malayalam" },
  { code: "mn", name: "Mongolian" },
  { code: "mr", name: "Marathi" },
  { code: "ms", name: "Malay" },
  { code: "mt", name: "Maltese" },
  { code: "my", name: "Burmese" },
  { code: "ne", name: "Nepali" },
  { code: "nl", name: "Dutch" },
  { code: "no", name: "Norwegian" },
  { code: "ny", name: "Chichewa" },
  { code: "pa", name: "Punjabi" },
  { code: "pl", name: "Polish" },
  { code: "ps", name: "Pashto" },
  { code: "pt", name: "Portuguese" },
  { code: "ro", name: "Romanian" },
  { code: "ru", name: "Russian" },
  { code: "rw", name: "Kinyarwanda" },
  { code: "sd", name: "Sindhi" },
  { code: "si", name: "Sinhala" },
  { code: "sk", name: "Slovak" },
  { code: "sl", name: "Slovenian" },
  { code: "sm", name: "Samoan" },
  { code: "sn", name: "Shona" },
  { code: "so", name: "Somali" },
  { code: "sq", name: "Albanian" },
  { code: "sr", name: "Serbian" },
  { code: "st", name: "Sesotho" },
  { code: "su", name: "Sundanese" },
  { code: "sv", name: "Swedish" },
  { code: "sw", name: "Swahili" },
  { code: "ta", name: "Tamil" },
  { code: "te", name: "Telugu" },
  { code: "tg", name: "Tajik" },
  { code: "th", name: "Thai" },
  { code: "tk", name: "Turkmen" },
  { code: "tl", name: "Filipino" },
  { code: "tr", name: "Turkish" },
  { code: "tt", name: "Tatar" },
  { code: "ug", name: "Uyghur" },
  { code: "uk", name: "Ukrainian" },
  { code: "ur", name: "Urdu" },
  { code: "uz", name: "Uzbek" },
  { code: "vi", name: "Vietnamese" },
  { code: "xh", name: "Xhosa" },
  { code: "yi", name: "Yiddish" },
  { code: "yo", name: "Yoruba" },
  { code: "zh", name: "Chinese" },
  { code: "zu", name: "Zulu" },
];

async function translateWithOpenAI(text, targetLanguage, apiKey) {
  const targetLanguageName = languageNames[targetLanguage] || targetLanguage;

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content: `You are a translator. Translate the following text to ${targetLanguageName}. Preserve formatting and tone. Only return the translated text without explanations.`,
          },
          {
            role: "user",
            content: text,
          },
        ],
        temperature: 0.3,
        max_tokens: 1000,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error(
      "OpenAI translation error:",
      error.response?.data || error.message
    );
    throw new Error(
      error.response?.data?.error?.message || "OpenAI translation failed"
    );
  }
}

async function translateWithGemini(text, targetLanguage, apiKey) {
  const targetLanguageName = languageNames[targetLanguage] || targetLanguage;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`,
      {
        contents: [
          {
            parts: [
              {
                text: `Translate the following text to ${targetLanguageName}. Only return the translated text without explanations:\n\n${text}`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1000,
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.candidates[0].content.parts[0].text.trim();
  } catch (error) {
    console.error(
      "Gemini translation error:",
      error.response?.data || error.message
    );
    throw new Error(
      error.response?.data?.error?.message || "Gemini translation failed"
    );
  }
}

async function translateWithDeepseek(text, targetLanguage, apiKey) {
  const targetLanguageName = languageNames[targetLanguage] || targetLanguage;

  try {
    const response = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: `You are a translator. Translate the following text to ${targetLanguageName}. Preserve formatting and tone. Only return the translated text without explanations.`,
          },
          {
            role: "user",
            content: text,
          },
        ],
        temperature: 0.3,
        max_tokens: 1000,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error(
      "Deepseek translation error:",
      error.response?.data || error.message
    );
    throw new Error(
      error.response?.data?.error?.message || "Deepseek translation failed"
    );
  }
}

module.exports = {
  translateWithOpenAI,
  translateWithGemini,
  translateWithDeepseek,
  formatPhoneNumber,
  sendTemplateMessage,
  isValidEmail,
  downloadAndExtractFile,
  folderExists,
  sendAPIMessage,
  sendEmail,
  getUserPlayDays,
  getNumberOfDaysFromTimestamp,
  getUserOrderssByMonth,
  getUserSignupsByMonth,
  validateEmail,
  updateUserPlan,
  getFileInfo,
  uploadFileMeta,
  getMetaNumberDetail,
  getSessionUploadMediaMeta,
  sendMetaMsg,
  updateMetaTempletInMsg,
  sendMetatemplet,
  delMetaTemplet,
  getAllTempletsMeta,
  createMetaTemplet,
  getBusinessPhoneNumber,
  botWebhook,
  mergeArrays,
  readJSONFile,
  writeJsonToFile,
  getCurrentTimestampInTimeZone,
  saveWebhookConversation,
  saveJsonToFile,
  readJsonFromFile,
  deleteFileIfExists,
  areMobileNumbersFilled,
  getFileExtension,
  executeQueries,
  fetchProfileFun,
  returnWidget,
  generateWhatsAppURL,
  makeRequest,
  replacePlaceholders,
  runChatbot,
  rzCapturePayment,
  validateFacebookToken,
  addObjectToFile,
  extractFileName,
  checkWarmerPlan,
  saveMessageToConversation,
  importChatsFromv3,
  importConversationsFromJson,
  makeRequestBeta,
  sendEmailBeta,
  executeMySQLQuery,
  getAllTempletsMetaBeta,
  extractTemplateVariablesBeta,
  getRecentMessages,
  suggestReplyWithOpenAI,
  suggestReplyWithGemini,
  suggestReplyWithDeepseek,
};
