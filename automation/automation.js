const flowProcessor = require("./functions");
const { query } = require("../database/dbpromise");

async function processFlow({
  nodes,
  edges,
  uid,
  flowId,
  message,
  incomingText,
  user,
  sessionId,
  origin,
  chatId,
  element,
}) {
  let result = { moveToNextNode: false };
  const flowSession = await flowProcessor.getFlowSession({
    flowId,
    message,
    uid,
    nodes,
    incomingText,
    edges,
    sessionId,
    origin,
  });

  // returning if chat is disabled
  const checkIfDisabled = await flowProcessor.checkIfChatDisabled({
    flowSession,
  });

  if (checkIfDisabled && flowSession?.data?.disableChat?.timestamp) {
    return console.log("Chat found disabled", { checkIfDisabled });
  }
  // returning if chat is disabled end

  // checking if its assigend to ai
  const checkIfAssignedToAi = flowSession?.data?.assignedToAi;
  if (checkIfAssignedToAi) {
    console.log("Chat is assigned to AI, ai flow processing");
    await flowProcessor.processAiTransfer({
      chatId,
      message,
      node: flowSession?.data?.assignedToAi?.node,
      origin,
      sessionId,
      user,
      nodes,
      edges,
      flowSession,
      element,
      variablesObj,
      incomingText,
    });
    return;
  }

  if (!flowSession?.data?.node) {
    console.log(
      "Flow looks incomplete tryeing to delete session and try again "
    );
    if (origin === "qr") {
      await query(
        `DELETE FROM flow_session WHERE uid = ? AND origin = ? AND origin_id = ? AND flow_id = ? AND sender_mobile = ?`,
        [uid, origin, sessionId, flowId, message.senderMobile]
      );
    } else {
      await query(
        `DELETE FROM flow_session WHERE uid = ? AND origin = ? AND origin_id = ? AND flow_id = ? AND sender_mobile = ?`,
        [uid, "meta", "META", flowId, message.senderMobile]
      );
    }
    await processFlow({
      nodes,
      edges,
      uid,
      flowId: element.flow_id,
      message,
      incomingText,
      user,
      sessionId,
      origin,
      chatId,
      element,
    });
  }

  const { node: oldNode } = flowSession?.data;
  const variablesObj = flowSession?.data?.variables || {};

  // updating variabls
  let node;

  node = {
    ...oldNode,
    data: {
      ...oldNode?.data,
      content: flowProcessor.replaceVariables(
        oldNode?.data?.content,
        variablesObj
      ),
    },
  };

  switch (node.type) {
    case "SEND_MESSAGE":
      result = await flowProcessor.processSendMessage({
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
        incomingText,
      });
      break;

    case "CONDITION":
      result = await flowProcessor.processCondition({
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
        incomingText,
      });
      break;

    case "RESPONSE_SAVER":
      result = await flowProcessor.processResponseSaver({
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
        incomingText,
      });
      break;

    case "DISABLE_AUTOREPLY":
      result = await flowProcessor.processDisableAutoReply({
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
        incomingText,
      });
      break;

    case "MAKE_REQUEST":
      result = await flowProcessor.processMakeRequest({
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
        incomingText,
      });
      break;

    case "DELAY":
      result = await flowProcessor.processDelay({
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
        incomingText,
      });
      break;

    case "SPREADSHEET":
      result = await flowProcessor.processSpreadSheet({
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
        incomingText,
      });
      break;

    case "EMAIL":
      result = await flowProcessor.processSendEmail({
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
        incomingText,
      });
      break;

    case "AGENT_TRANSFER":
      result = await flowProcessor.processAgentTransfer({
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
        incomingText,
      });
      break;

    case "AI_TRANSFER":
      result = await flowProcessor.processAiTransfer({
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
        incomingText,
      });
      break;

    case "MYSQL_QUERY":
      result = await flowProcessor.processMysqlQuery({
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
        incomingText,
      });
      break;

    default:
      break;
  }

  console.log({ s: result?.moveToNextNode, type: node.type });

  if (result?.moveToNextNode) {
    setTimeout(async () => {
      await processFlow({
        nodes,
        edges,
        uid,
        flowId: element.flow_id,
        message,
        incomingText,
        user,
        sessionId,
        origin,
        chatId,
        element,
      });
    }, 1000);
  }
  try {
  } catch (err) {
    console.log(err);
  }
}

async function processAutomation({
  uid,
  message,
  user,
  sessionId,
  origin,
  chatId,
}) {
  const incomingText = flowProcessor.extractBodyText(message);
  const { senderMobile, senderName } = message;
  const userFlows = await flowProcessor.getActiveFlows({
    uid,
    origin,
    sessionId,
  });

  if (userFlows?.length < 1) {
    return console.log("User does not have any active automation flow");
  }

  if (!senderMobile) {
    return console.log("Invalid message found", message);
  }

  userFlows.forEach(async (element) => {
    try {
      // processing one flow
      const flowData = JSON.parse(element.data) || {};
      const nodes = flowData?.nodes || [];
      const edges = flowData?.edges || [];

      if (nodes?.length < 1 || edges?.length < 1) {
        return console.log(
          "Either nodes or edges length is zero of this automation flow with id:",
          element.flow_id
        );
      }

      await processFlow({
        nodes,
        edges,
        uid,
        flowId: element.flow_id,
        message,
        incomingText,
        user,
        sessionId,
        origin,
        chatId,
        element,
      });
    } catch (err) {
      console.log(err);
    }
  });
}

module.exports = { processAutomation };
