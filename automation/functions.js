const { query } = require("../database/dbpromise");
const {
  getCurrentTimestampInTimeZone,
  saveMessageToConversation,
  makeRequestBeta,
  sendEmailBeta,
  executeMySQLQuery,
} = require("../functions/function");
const { setQrMsgObj, sendMetaMsg } = require("../helper/socket/function");
const fetch = require("node-fetch");
const { google } = require("googleapis");
const { aiTransferHandler } = require("./useAITransferHandler");

const replaceJsonWithVarsNew = (data, variables) => {
  // Recursively handle different types of values (string, object, array)
  const processValue = (val, variables) => {
    if (typeof val === "string") {
      // If the value is a string, check if it contains a placeholder
      const regex = /{{{(.*?)}}}/g;
      return val.replace(regex, (match, key) => {
        // Extract the key and try to get the corresponding value from the variables object
        let keys = key.split(".");
        let resolvedValue = variables;
        for (const k of keys) {
          resolvedValue = resolvedValue ? resolvedValue[k] : undefined;
        }
        return resolvedValue !== undefined ? resolvedValue : match; // If not found, keep the original value
      });
    }

    if (Array.isArray(val)) {
      return val.map((item) => processValue(item, variables));
    }

    if (typeof val === "object" && val !== null) {
      const result = {};
      for (const key in val) {
        result[key] = processValue(val[key], variables);
      }
      return result;
    }

    return val; // Return the value if it's not a string, array, or object
  };

  return processValue(data, variables);
};

async function pushNewKeyInData({ key, pushObj, flowSession }) {
  try {
    // Fetch existing data from the database
    const oldData = await query(`SELECT * FROM flow_session WHERE id = ?`, [
      flowSession?.id,
    ]);

    if (!oldData || oldData.length < 1) {
      console.log("No data found for the provided flowSession ID.");
      return;
    }

    // Parse the existing data
    const oldDataObj = JSON.parse(oldData[0]?.data || "{}");

    // Check if the key exists in the data, if not initialize it as an empty object
    if (!oldDataObj[key]) {
      oldDataObj[key] = {}; // Initialize it if it doesn't exist
    }

    // Merge old data under the key with the new pushObj
    oldDataObj[key] = {
      ...oldDataObj[key],
      ...pushObj, // Merge the new object into the existing key
    };

    await query(`UPDATE flow_session SET data = ? WHERE id = ?`, [
      JSON.stringify(oldDataObj),
      flowSession?.id,
    ]);
  } catch (err) {
    console.log("Error during updating flow_session data:", err);
  }
}

function replaceVarFromString(inputString, variables) {
  return inputString.replace(
    /{{{(\w+)}}}/g,
    (match, p1) => variables[p1] || match
  );
}

const replaceJsonWithVar = (val, variables) => {
  console.log({ val, variables });
  if (typeof val === "string") {
    if (val.startsWith("{{{") && val.endsWith("}}}")) {
      const key = val.slice(3, -3).trim();
      const keys = key.split(".");
      let resolvedValue = variables;

      for (const k of keys) {
        resolvedValue = resolvedValue && resolvedValue[k];
      }

      return resolvedValue !== undefined ? resolvedValue : val;
    } else {
      return val;
    }
  }

  if (typeof val === "object" && val !== null) {
    const result = Array.isArray(val) ? [] : {};
    for (const key in val) {
      result[key] = replaceJsonWithVar(val[key], variables);
    }
    return result;
  }

  return val;
};

async function authenticate(credentials) {
  const { client_email, private_key } = credentials;

  const auth = new google.auth.JWT(client_email, null, private_key, [
    "https://www.googleapis.com/auth/spreadsheets",
  ]);
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

async function getSheetByName(sheets, spreadsheetId, sheetName) {
  try {
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId,
    });

    const sheet = spreadsheet.data.sheets.find(
      (s) => s.properties.title === sheetName
    );

    if (!sheet) {
      return { exists: false };
    }

    const data = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:Z`,
    });

    return {
      exists: true,
      data: data.data.values || [],
      sheetId: sheet.properties.sheetId,
      properties: sheet.properties,
    };
  } catch (error) {
    console.error("Error getting sheet:", error.message);
    throw error;
  }
}

async function pushOrCreateSheet(sheets, spreadsheetId, sheetName, data) {
  try {
    // First check if sheet exists
    const sheetInfo = await getSheetByName(sheets, spreadsheetId, sheetName);

    if (!sheetInfo.exists) {
      // Create the sheet if it doesn't exist
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: sheetName,
                  gridProperties: {
                    rowCount: 1000,
                    columnCount: 26,
                  },
                },
              },
            },
          ],
        },
      });
      console.log(`Created new sheet: ${sheetName}`);
    }

    // Prepare data (convert object to array if needed)
    const values = Array.isArray(data) ? data : [Object.values(data)];

    // Push data to sheet
    const result = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      resource: { values },
    });

    return {
      success: true,
      updatedCells: result.data.updates.updatedCells,
      updatedRange: result.data.updates.updatedRange,
    };
  } catch (error) {
    console.error("Error in pushOrCreateSheet:", error.message);
    throw error;
  }
}

async function pushSpreadSheet({ authUrl, sheetName, sheetId, jsonData }) {
  try {
    const res = await fetch(authUrl);
    if (!res.ok) throw new Error("Failed to fetch service account JSON");
    const credsPath = await res.json();

    const spreadsheetId = sheetId;

    const sheets = await authenticate(credsPath);
    const sheetData = await getSheetByName(sheets, spreadsheetId, sheetName);
    console.log("Sheet exists:", sheetData.exists);

    const pushResult = await pushOrCreateSheet(
      sheets,
      spreadsheetId,
      sheetName,
      jsonData
    );

    console.log("Push result:", pushResult);
  } catch (err) {
    console.log(err);
  }
}

function delay(sec) {
  return new Promise((resolve) => setTimeout(resolve, sec * 1000));
}

function mapVariablesToResponse(variables, response) {
  function getNestedValue(obj, path) {
    return path.split(".").reduce((acc, part) => acc && acc[part], obj);
  }

  const result = {};

  // Loop through each variable in the variables array
  variables.forEach((variable) => {
    const { key, value } = variable;

    // Safely access the property in response.body using value (e.g., body.name)
    if (value && value.startsWith("body.")) {
      const path = value.slice(5); // Removing 'body.' prefix

      // Use a helper function to safely access nested values
      const resultValue = getNestedValue(response.body, path);

      if (resultValue !== undefined) {
        result[key] = resultValue;
      }
    }
  });

  return result;
}

function addDurationToTimestamp(hours, minutes) {
  // Get the current timestamp
  let currentTime = new Date();

  // Add hours and minutes to the current time
  currentTime.setHours(currentTime.getHours() + hours);
  currentTime.setMinutes(currentTime.getMinutes() + minutes);

  // Return the timestamp
  return currentTime.getTime();
}

function setVariables(variables, obj) {
  const result = {};

  variables.forEach((variable) => {
    const pathParts = variable.responsePath.split(".");

    let value = obj;

    for (let part of pathParts) {
      const match = part.match(/^(\w+)\[(\d+)\]$/);
      if (match) {
        // e.g., response[0]
        const key = match[1];
        const index = parseInt(match[2], 10);
        if (
          value[key] &&
          Array.isArray(value[key]) &&
          value[key][index] !== undefined
        ) {
          value = value[key][index];
        } else {
          value = "NA";
          break;
        }
      } else {
        // normal property access
        if (value && value[part] !== undefined) {
          value = value[part];
        } else {
          value = "NA";
          break;
        }
      }
    }

    if (typeof value === "object" && value !== null) {
      value = JSON.stringify(value);
    }

    result[variable.varName] = value;
  });

  return result;
}

const matchCondition = (conditions, incomingText) => {
  // Loop through each condition
  for (let condition of conditions) {
    const { type, value, caseSensitive } = condition;

    // Adjust value and incomingText based on caseSensitive flag
    const processedValue = caseSensitive ? value : value.toLowerCase();
    const processedText = caseSensitive
      ? incomingText
      : incomingText.toLowerCase();

    switch (type) {
      case "text_exact":
        if (processedText === processedValue) {
          return condition; // Exact match
        }
        break;
      case "text_contains":
        if (processedText.includes(processedValue)) {
          return condition; // Text contains condition
        }
        break;
      case "text_starts_with":
        if (processedText.startsWith(processedValue)) {
          return condition; // Text starts with condition
        }
        break;
      case "text_ends_with":
        if (processedText.endsWith(processedValue)) {
          return condition; // Text ends with condition
        }
        break;
      case "number_equals":
        if (Number(processedText) === Number(processedValue)) {
          return condition; // Number equality condition
        }
        break;
      case "number_greater":
        if (Number(processedText) > Number(processedValue)) {
          return condition; // Greater than condition
        }
        break;
      case "number_less":
        if (Number(processedText) < Number(processedValue)) {
          return condition; // Less than condition
        }
        break;
      case "number_between":
        const [min, max] = processedValue
          .split(",")
          .map((num) => Number(num.trim()));
        if (Number(processedText) >= min && Number(processedText) <= max) {
          return condition; // Number between condition
        }
        break;
      default:
        break;
    }
  }
  return null; // Return null if no condition matched
};

function extractBodyText(message) {
  const messageBody =
    message?.msgContext?.text?.body ||
    message?.msgContext?.interactive?.body?.text ||
    message?.msgContext?.image?.caption ||
    message?.msgContext?.image?.link ||
    message?.msgContext?.video?.caption ||
    message?.msgContext?.video?.link ||
    message?.msgContext?.document?.caption ||
    message?.msgContext?.reaction?.emoji ||
    message?.msgContext?.location ||
    message?.msgContext?.contact?.contacts?.[0]?.name?.formatted_name;

  return messageBody;
}

function timeoutPromise(promise, ms) {
  const timeout = new Promise(
    (resolve) => setTimeout(() => resolve(null), ms) // Instead of rejecting, resolve null
  );
  return Promise.race([promise, timeout]);
}

function replaceVariables(input, variables = {}) {
  // Handle null or undefined input
  if (input === null || input === undefined) {
    return input;
  }

  // Handle strings
  if (typeof input === "string") {
    return input.replace(/\{\{\{([^{}]+)\}\}\}/g, (match, key) => {
      return variables.hasOwnProperty(key) ? variables[key] : match;
    });
  }

  // Handle arrays
  if (Array.isArray(input)) {
    return input.map((item) => replaceVariables(item, variables));
  }

  // Handle objects
  if (typeof input === "object") {
    const result = {};
    for (const [key, value] of Object.entries(input)) {
      result[key] = replaceVariables(value, variables);
    }
    return result;
  }

  // Return primitives as-is
  return input;
}

async function sendWaMessage({
  origin,
  node,
  sessionId,
  message,
  isGroup = false,
  uid,
  variablesObj,
  content = null,
}) {
  try {
    let sendMsgId = null;

    if (origin === "qr") {
      const {
        getSession,
        formatGroup,
        formatPhone,
      } = require("../helper/addon/qr/index");

      const convertMsgToQR = setQrMsgObj(content || node?.data?.content);
      const session = await timeoutPromise(getSession(sessionId || "a"), 60000);
      if (!session) {
        sendMsgId = null;
      } else {
        const jid = isGroup
          ? formatGroup(message.senderMobile)
          : formatPhone(message.senderMobile);

        const send = await timeoutPromise(
          session?.sendMessage(jid, convertMsgToQR),
          60000
        );

        sendMsgId = send?.key?.id || null;
      }
    } else {
      const send = await sendMetaMsg({
        msgObj: content || node?.data?.content,
        to: message.senderMobile,
        uid,
      });
      sendMsgId = send?.id || null;
    }

    return sendMsgId;
  } catch (err) {
    console.log(err);
  }
}

async function getActiveFlows({ uid, origin, sessionId }) {
  try {
    const [user] = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);

    if (!user?.plan) return [];

    const plan = JSON.parse(user.plan);

    if (plan.allow_chatbot <= 0) return [];

    let chatbots = [];

    if (origin === "qr" && sessionId) {
      chatbots = await query(
        `SELECT * FROM beta_chatbot WHERE uid = ? AND origin_id = ? AND active = ?`,
        [uid, sessionId, 1]
      );
    } else {
      chatbots = await query(
        `SELECT * FROM beta_chatbot WHERE uid = ? AND origin_id = ? AND active = ?`,
        [uid, "META", 1]
      );
    }

    if (chatbots?.length < 1) {
      return [];
    } else {
      const flowData = await Promise.all(
        chatbots.map(async (element) => {
          const flows = await query(
            `SELECT * FROM beta_flows WHERE uid = ? AND is_active = ? AND source = ? AND flow_id = ?`,
            [uid, 1, "wa_chatbot", element?.flow_id]
          );
          return flows;
        })
      );

      return flowData?.flat();
    }
  } catch (err) {
    console.error("Error in getActiveFlows:", err);
    throw err;
  }
}

async function getFlowSession({
  flowId,
  message,
  uid,
  nodes = [],
  incomingText,
  edges = [],
  sessionId,
  origin,
}) {
  try {
    if (!message?.senderMobile) return null;

    // Check for existing session
    let [flowSession] = await query(
      `SELECT * FROM flow_session WHERE uid = ? AND flow_id = ? AND sender_mobile = ?`,
      [uid, flowId, message.senderMobile]
    );

    if (!flowSession) {
      const initialFlow = nodes.find((n) => n.id === "initialNode");
      const getEdge = edges.find((e) => e.source === initialFlow?.id);
      const getNode = nodes.find((n) => n.id === getEdge?.target);

      if (!getNode) return null;

      // Insert new session
      await query(
        `INSERT INTO flow_session (uid, origin, origin_id, flow_id, sender_mobile, data) VALUES (?,?,?,?,?,?)`,
        [
          uid,
          origin,
          sessionId,
          flowId,
          message.senderMobile,
          JSON.stringify({
            variables: {
              senderMobile: message.senderMobile,
              senderName: message.senderName,
              senderMessage: incomingText,
            },
            node: getNode,
          }),
        ]
      );

      // Get newly created session
      [flowSession] = await query(
        `SELECT * FROM flow_session WHERE uid = ? AND flow_id = ? AND sender_mobile = ?`,
        [uid, flowId, message.senderMobile]
      );
    }

    if (!flowSession) return null;

    const fData = JSON.parse(flowSession.data);
    // updating varisbles name, mobile, message
    let variablesObj = fData?.variables || {};
    variablesObj.senderMobile = message.senderMobile;
    variablesObj.senderName = message.senderName;
    variablesObj.senderMessage = incomingText;
    fData.variables = variablesObj;

    const updatingNode = nodes.find((x) => x.id === fData?.node?.id);

    return {
      ...flowSession,
      data: { ...fData, node: updatingNode },
    };
  } catch (err) {
    console.error("Error in getFlowSession:", err);
    return null;
  }
}

async function processSendMessage({
  node,
  sessionId,
  user,
  message,
  chatId,
  origin,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
}) {
  try {
    const uid = user?.uid;

    const sendMsg = await sendWaMessage({
      message,
      node,
      origin,
      sessionId,
      isGroup: false,
      uid,
    });

    const userTimezone = getCurrentTimestampInTimeZone(
      user?.timezone || "Asia/Kolkata"
    );

    if (sendMsg) {
      const messageData = {
        type: node?.data?.type?.type,
        metaChatId: sendMsg,
        msgContext: node?.data?.content,
        reaction: "",
        timestamp: parseInt(userTimezone) + 1,
        senderName: message.senderName,
        senderMobile: message.senderMobile,
        star: 0,
        route: "OUTGOING",
        context: null,
        origin: origin,
      };

      await saveMessageToConversation({
        uid: uid,
        chatId,
        messageData,
      });

      await query(
        `UPDATE beta_chats SET last_message = ? WHERE chat_id = ? AND uid = ?`,
        [JSON.stringify(messageData), chatId, uid]
      );

      // finding new id
      const e = edges.find((e) => e.source === node.id);
      if (!e) return {};
      const n = nodes.find((n) => n.id === e.target);

      if (n) {
        const oldData = flowSession?.data;
        const newData = { ...oldData, node: n };
        await query(
          `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
          [
            JSON.stringify(newData),
            element?.flow_id,
            uid,
            message?.senderMobile,
          ]
        );
        return { moveToNextNode: node?.data?.moveToNextNode || false };
      } else {
        return {};
      }
    } else {
      return {};
    }
  } catch (err) {
    console.log(err);
    return {};
  }
}

async function processCondition({
  chatId,
  message,
  node,
  origin,
  sessionId,
  user,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
  incomingText: incomingTextOld,
}) {
  try {
    const { uid } = user;
    let incomingText;
    if (node?.data.variable?.active) {
      incomingText = replaceVariables(incomingTextOld, variablesObj);
    } else {
      incomingText = incomingTextOld;
    }

    const getCondition = matchCondition(
      node?.data?.conditions || [],
      incomingText
    );

    if (getCondition) {
      const e =
        edges?.find((e) => e.sourceHandle === getCondition?.targetNodeId) || {};
      const n = nodes?.find((n) => n.id === e?.target);
      if (n) {
        const oldData = flowSession?.data;
        const newData = { ...oldData, node: n };
        await query(
          `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
          [
            JSON.stringify(newData),
            element?.flow_id,
            uid,
            message?.senderMobile,
          ]
        );
      }
    } else {
      // process default condition if not matched
      const e =
        edges?.find(
          (e) => e.source === node?.id && e.sourceHandle === "default"
        ) || {};
      const n = nodes?.find((n) => n.id === e?.target);
      if (n) {
        const oldData = flowSession?.data;
        const newData = { ...oldData, node: n };
        await query(
          `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
          [
            JSON.stringify(newData),
            element?.flow_id,
            uid,
            message?.senderMobile,
          ]
        );
      }
    }

    return { moveToNextNode: node?.data?.moveToNextNode };
  } catch (err) {
    console.log(err);
    return {};
  }
}

async function processResponseSaver({
  chatId,
  message,
  node,
  origin,
  sessionId,
  user,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
  incomingText: incomingTextOld,
}) {
  try {
    const { uid } = user;
    const newVars = node?.data?.variables || [];
    const convertVar = setVariables(newVars, { message });
    const savingVars = { ...(variablesObj || {}), ...(convertVar || {}) };

    const e = edges.find((e) => e.source === node.id);
    if (!e) return {};

    const n = nodes.find((n) => n.id === e.target);
    if (!n) return {};

    const newData = {
      ...(flowSession?.data || {}),
      node: n,
      variables: savingVars,
    };

    await query(
      `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
      [JSON.stringify(newData), element?.flow_id, uid, message?.senderMobile]
    );

    return { moveToNextNode: node?.data?.moveToNextNode || false };
  } catch (err) {
    console.error("Error in processResponseSaver:", err);
    return {};
  }
}

async function checkIfChatDisabled({ flowSession }) {
  try {
    const tS = flowSession?.data?.disableChat?.timestamp || 0;
    let currentTime = new Date().getTime();
    return tS < currentTime;
  } catch (err) {
    console.log(err);
    return false;
  }
}

async function processDisableAutoReply({
  chatId,
  message,
  node,
  origin,
  sessionId,
  user,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
  incomingText: incomingTextOld,
}) {
  try {
    const { uid } = user;
    const { hours, minutes } = node.data;
    const old = flowSession?.data;
    const timeStamp = addDurationToTimestamp(
      parseInt(hours) || 0,
      parseInt(minutes) || 0
    );
    const newData = {
      ...old,
      disableChat: { node, timestamp: timeStamp },
    };

    await query(
      `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
      [JSON.stringify(newData), element?.flow_id, uid, message?.senderMobile]
    );

    console.log("DISABLE CHAT", { hours, minutes });

    return { moveToNextNode: node?.data?.moveToNextNode || false };
  } catch (err) {
    console.log(err);
    return {};
  }
}

async function processMakeRequest({
  chatId,
  message,
  node,
  origin,
  sessionId,
  user,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
  incomingText: incomingTextOld,
}) {
  try {
    const { uid } = user;
    const config = node.data;
    const resp = await makeRequestBeta(config, variablesObj);
    let allVars;

    if (resp.success) {
      const oldVars = flowSession?.data?.variables;
      const varFromReq = mapVariablesToResponse(
        node?.data?.variables || [],
        resp.data
      );
      allVars = { ...varFromReq, ...oldVars };
    } else {
      allVars = flowSession?.data?.variables;
    }

    const e = edges.find((e) => e.source === node.id);
    if (!e) return {};

    const n = nodes.find((n) => n.id === e.target);
    if (!n) return {};

    const newData = {
      ...(flowSession?.data || {}),
      node: n,
      variables: allVars,
    };

    await query(
      `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
      [JSON.stringify(newData), element?.flow_id, uid, message?.senderMobile]
    );

    return { moveToNextNode: node?.data?.moveToNextNode || false };
  } catch (err) {
    console.log(err);
    return {};
  }
}

async function processDelay({
  chatId,
  message,
  node,
  origin,
  sessionId,
  user,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
  incomingText: incomingTextOld,
}) {
  try {
    const { uid } = user;
    const { seconds } = node.data;
    console.log(`Message waiting for ${seconds} sec`);
    await delay(seconds || 0);

    const e = edges.find((e) => e.source === node.id);
    if (!e) return {};
    const n = nodes.find((n) => n.id === e.target);
    if (!n) return {};

    const oldData = flowSession?.data;
    const newData = { ...oldData, node: n };
    await query(
      `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
      [JSON.stringify(newData), element?.flow_id, uid, message?.senderMobile]
    );

    return { moveToNextNode: node?.data?.moveToNextNode || false };
  } catch (err) {
    console.log(err);
    return {};
  }
}

async function processSpreadSheet({
  chatId,
  message,
  node,
  origin,
  sessionId,
  user,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
  incomingText: incomingTextOld,
}) {
  try {
    const { uid } = user;
    const { authUrl, authLabel, jsonData, sheetName, sheetId } = node.data;

    if (authUrl && authLabel && jsonData && sheetName && sheetId) {
      await pushSpreadSheet({
        authUrl,
        sheetName,
        sheetId,
        jsonData: replaceJsonWithVar(jsonData, variablesObj),
      });
    }

    const e = edges.find((e) => e.source === node.id);
    if (!e) return {};
    const n = nodes.find((n) => n.id === e.target);
    if (!n) return {};

    const oldData = flowSession?.data;
    const newData = { ...oldData, node: n };
    await query(
      `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
      [JSON.stringify(newData), element?.flow_id, uid, message?.senderMobile]
    );

    return { moveToNextNode: node?.data?.moveToNextNode || false };
  } catch (err) {
    console.log(err);
    return {};
  }
}

async function processSendEmail({
  chatId,
  message,
  node,
  origin,
  sessionId,
  user,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
  incomingText: incomingTextOld,
}) {
  try {
    const { uid } = user;
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
    } = node.data;

    console.log("sending email");
    await sendEmailBeta({
      host,
      port,
      email,
      pass,
      username,
      from,
      to: replaceVarFromString(to, variablesObj),
      subject: replaceVarFromString(subject, variablesObj),
      html: replaceVarFromString(html, variablesObj),
      security,
      useAuth,
    });
    console.log("email sent");

    const e = edges.find((e) => e.source === node.id);
    if (!e) return {};
    const n = nodes.find((n) => n.id === e.target);
    if (!n) return {};

    const oldData = flowSession?.data;
    const newData = { ...oldData, node: n };
    await query(
      `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
      [JSON.stringify(newData), element?.flow_id, uid, message?.senderMobile]
    );

    return { moveToNextNode: node?.data?.moveToNextNode || false };
  } catch (err) {
    console.log(err);
    return {};
  }
}

async function processAgentTransfer({
  chatId,
  message,
  node,
  origin,
  sessionId,
  user,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
  incomingText: incomingTextOld,
}) {
  try {
    const { uid } = user;
    const { agentData, autoAgentSelect } = node.data;

    let agentNewData = null;

    if (autoAgentSelect) {
      const agentData = await query(
        `SELECT * FROM agents WHERE uid = ? AND is_active = ?`,
        [uid, 1]
      );
      if (agentData?.length > 0) {
        const randomAgent =
          agentData[Math.floor(Math.random() * agentData.length)];
        agentNewData = randomAgent;
      } else {
        console.log("No active agents found for transfer.");
        return { moveToNextNode: node?.data?.moveToNextNode || false };
      }
    } else {
      const [findAgent] = await query(
        `SELECT * FROM agents WHERE owner_uid = ? AND uid = ?`,
        [uid, agentData?.uid]
      );
      if (findAgent) {
        agentNewData = findAgent;
      }
    }

    if (agentNewData) {
      await query(
        `UPDATE beta_chats SET assigned_agent = ? WHERE uid = ? AND chat_id = ?`,
        [JSON.stringify(agentNewData), uid, chatId]
      );
    }

    const e = edges.find((e) => e.source === node.id);
    if (!e) return {};
    const n = nodes.find((n) => n.id === e.target);
    if (!n) return {};

    const oldData = flowSession?.data;
    const newData = { ...oldData, node: n };
    await query(
      `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
      [JSON.stringify(newData), element?.flow_id, uid, message?.senderMobile]
    );

    return { moveToNextNode: node?.data?.moveToNextNode || false };
  } catch (err) {
    console.log(err);
    return {};
  }
}

async function processAiTransfer({
  chatId,
  message,
  node,
  origin,
  sessionId,
  user,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
  incomingText: incomingTextOld,
}) {
  try {
    const { uid } = user;
    const config = node.data;

    // returning if message is not text
    if (message?.msgContext?.type !== "text") {
      return { moveToNextNode: node?.data?.moveToNextNode || false };
    }

    if (config?.assignedToAi) {
      // updating mysql with ai
      let a = flowSession?.data || {};
      a.aiTransfer = { active: true, node: node };
      await query(
        `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
        [JSON.stringify(a), element?.flow_id, uid, message?.senderMobile]
      );
    } else {
      const e = edges.find((e) => e.source === node.id);
      console.log({ e });
      if (!e) return {};
      const n = nodes.find((n) => n.id === e.target);
      console.log({ n });
      if (!n) return {};

      const oldData = flowSession?.data;
      const newData = { ...oldData, node: n };
      await query(
        `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
        [JSON.stringify(newData), element?.flow_id, uid, message?.senderMobile]
      );
    }

    let conversationArr = await query(
      `SELECT * FROM beta_conversation WHERE chat_id = ? AND uid = ? AND route = ? ORDER BY timestamp DESC LIMIT ${
        node?.data?.messageReferenceCount || 1
      }`,
      [chatId, uid, "INCOMING"]
    );

    conversationArr = [...conversationArr]?.reverse() || [];

    // console.log(
    //   conversationArr.map(
    //     (x) => JSON.parse(x.msgContext)?.text?.body || x.msgContext
    //   )
    // );

    // console.log({ aiQuestion: conversationArr[conversationArr.length - 1] });

    const result = await aiTransferHandler(config, conversationArr);

    console.dir({ result }, { depth: null });

    if (result?.data?.message || result?.message) {
      const sendMsg = await sendWaMessage({
        message,
        node: {},
        origin,
        sessionId,
        isGroup: false,
        uid,
        content: {
          type: "text",
          text: {
            preview_url: true,
            body: result?.data?.message || result?.message,
          },
        },
      });

      const userTimezone = getCurrentTimestampInTimeZone(
        user?.timezone || "Asia/Kolkata"
      );

      if (sendMsg) {
        const messageData = {
          type: "text",
          metaChatId: sendMsg,
          msgContext: {
            type: "text",
            text: {
              preview_url: true,
              body: result?.data?.message || result?.message,
            },
          },
          reaction: "",
          timestamp: parseInt(userTimezone) + 1,
          senderName: message.senderName,
          senderMobile: message.senderMobile,
          star: 0,
          route: "OUTGOING",
          context: null,
          origin: origin,
        };

        await saveMessageToConversation({
          uid: uid,
          chatId,
          messageData,
        });

        await query(
          `UPDATE beta_chats SET last_message = ? WHERE chat_id = ? AND uid = ?`,
          [JSON.stringify(messageData), chatId, uid]
        );

        return {};
      } else {
        return {};
      }
    } else if (result?.data?.function?.length > 0) {
      const functionObj = result?.data?.function[0];
      const functionId = functionObj?.id;

      console.log({ functionId });

      const e = edges?.find((e) => e.sourceHandle === functionId) || {};
      const n = nodes?.find((n) => n.id === e?.target);

      console.log({ e, n });

      if (!n) return { moveToNextNode: node?.data?.moveToNextNode };

      if (n) {
        const oldData = flowSession?.data;
        const newData = {
          ...oldData,
          node: n,
          aiTransfer: { active: false, node: null },
        };
        await query(
          `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
          [
            JSON.stringify(newData),
            element?.flow_id,
            uid,
            message?.senderMobile,
          ]
        );
      }
      return { moveToNextNode: true };
    } else {
      console.dir({ result }, { depth: null });
    }
  } catch (err) {
    console.log(err);
    return {};
  }
}

async function processMysqlQuery({
  chatId,
  message,
  node,
  origin,
  sessionId,
  user,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
  incomingText: incomingTextOld,
}) {
  try {
    const { uid } = user;
    const { seconds } = node.data;

    let mysqlVars = {};
    const replaceVars = replaceJsonWithVarsNew(node.data, variablesObj);
    const resp = await executeMySQLQuery(replaceVars);

    if (resp.success) {
      mysqlVars = setVariables(node?.data?.variables || [], {
        response: resp.data,
      });
    }

    await pushNewKeyInData({
      key: "variables",
      pushObj: mysqlVars,
      flowSession,
    });

    const e = edges.find((e) => e.source === node.id);
    if (!e) return {};
    const n = nodes.find((n) => n.id === e.target);
    if (!n) return {};

    await pushNewKeyInData({
      key: "node",
      pushObj: n,
      flowSession,
    });

    return { moveToNextNode: node?.data?.moveToNextNode || false };
  } catch (err) {
    console.log(err);
    return {};
  }
}

module.exports = {
  extractBodyText,
  getActiveFlows,
  getFlowSession,
  processSendMessage,
  replaceVariables,
  processCondition,
  processResponseSaver,
  processDisableAutoReply,
  checkIfChatDisabled,
  processMakeRequest,
  processDelay,
  processSpreadSheet,
  processSendEmail,
  processAgentTransfer,
  processAiTransfer,
  processMysqlQuery,
};
