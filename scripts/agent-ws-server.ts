import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { runClaudeAgent, type AgentQuestion } from "../lib/agent/claude-adapter";

type IncomingMessage =
  | { type: "prompt"; text: string; sessionId?: string; newConversation?: boolean }
  | { type: "answer"; id: string; label: string };

type SessionState = {
  claudeSessionId: string | null;
  running: boolean;
};

const port = Number(process.env.FINANCE_AGENT_WS_PORT ?? 3761);
const server = createServer();
const wss = new WebSocketServer({ server, path: "/agent" });
const sessions = new Map<string, SessionState>();
const pendingQuestions = new Map<string, {
  ws: WebSocket;
  resolve: (label: string) => void;
  reject: (error: Error) => void;
}>();

wss.on("connection", (ws) => {
  send(ws, { type: "connected", sessions: [...sessions.keys()] });

  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as IncomingMessage;
    if (message.type === "prompt") {
      void runPrompt(ws, message);
      return;
    }
    if (message.type === "answer") {
      const pending = pendingQuestions.get(message.id);
      if (pending) {
        pending.resolve(message.label);
        pendingQuestions.delete(message.id);
      }
    }
  });

  ws.on("close", () => {
    for (const [id, pending] of pendingQuestions) {
      if (pending.ws === ws) {
        pending.reject(new Error("WebSocket client disconnected"));
        pendingQuestions.delete(id);
      }
    }
  });
});

async function runPrompt(ws: WebSocket, message: Extract<IncomingMessage, { type: "prompt" }>) {
  const sessionId = message.newConversation || !message.sessionId ? randomUUID() : message.sessionId;
  const session = sessions.get(sessionId) ?? { claudeSessionId: null, running: false };
  sessions.set(sessionId, session);

  if (session.running) {
    send(ws, { type: "error", sessionId, message: "当前会话仍在执行，请稍后再发。" });
    return;
  }

  session.running = true;
  send(ws, { type: "session", sessionId, claudeSessionId: session.claudeSessionId });
  send(ws, { type: "status", sessionId, text: "starting" });

  try {
    const result = await runClaudeAgent([{ role: "user", content: message.text }], {
      claudeSessionId: session.claudeSessionId,
      resumeSession: Boolean(session.claudeSessionId),
      requestId: `ws-${sessionId}`,
      onChunk: (content) => send(ws, { type: "chunk", sessionId, content }),
      onAgentEvent: (event) => send(ws, { type: "agent_event", sessionId, event }),
      resolveUserQuestion: (question) => askClient(ws, sessionId, question)
    });

    session.claudeSessionId = result.claudeSessionId ?? session.claudeSessionId;
    send(ws, {
      type: "done",
      sessionId,
      claudeSessionId: session.claudeSessionId,
      content: result.content
    });
  } catch (error) {
    send(ws, { type: "error", sessionId, message: error instanceof Error ? error.message : String(error) });
  } finally {
    session.running = false;
    send(ws, { type: "status", sessionId, text: "" });
  }
}

function askClient(ws: WebSocket, sessionId: string, question: AgentQuestion) {
  const id = randomUUID();
  send(ws, { type: "question", sessionId, id, question });
  return new Promise<string>((resolve, reject) => {
    pendingQuestions.set(id, { ws, resolve, reject });
  });
}

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

server.listen(port, () => {
  console.log(`finance-agent websocket server listening on ws://localhost:${port}/agent`);
});
