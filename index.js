
require("dotenv").config();

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const qrcode = require("qrcode-terminal");
const config = require("./config");

let ai;
let starting = false;

const processing = new Set();

function getText(message) {
    const m =
        message?.ephemeralMessage?.message ||
        message?.viewOnceMessage?.message ||
        message;

    return (
        m?.conversation ||
        m?.extendedTextMessage?.text ||
        m?.imageMessage?.caption ||
        m?.videoMessage?.caption ||
        ""
    ).trim();
}

// Primary + Backup AI system
async function generateAI(text) {
    try {
        console.log("Using Primary:", config.model);

        const response = await ai.models.generateContent({
            model: config.model,
            contents: text,
            config: {
                systemInstruction: config.systemPrompt,
                maxOutputTokens: 500
            }
        });

        if (response.text?.trim()) {
            console.log("Primary AI Success!");
            return response.text.trim();
        }

        throw new Error("Primary returned empty response");

    } catch (primaryError) {
        console.error("Primary AI Error:", primaryError.message);

        if (!config.backupModel) {
            throw primaryError;
        }

        console.log("Switching to Backup:", config.backupModel);

        const response = await ai.models.generateContent({
            model: config.backupModel,
            contents: text,
            config: {
                systemInstruction: config.systemPrompt,
                maxOutputTokens: 500
            }
        });

        const answer = response.text?.trim();

        if (!answer) {
            throw new Error("Backup returned empty response");
        }

        console.log("Backup AI Success!");
        return answer;
    }
}

async function startBot() {
    if (starting) return;
    starting = true;

    try {
        const { GoogleGenAI } = await import("@google/genai");

        ai = new GoogleGenAI({
            apiKey: process.env.GEMINI_API_KEY
        });

        const { state, saveCreds } =
            await useMultiFileAuthState("session");

        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: "silent" }),
            browser: ["MRFG AI LITE", "Chrome", "1.0.0"]
        });

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log("Scan this QR:");
                qrcode.generate(qr, { small: true });
            }

            if (connection === "open") {
                console.log("MRFG AI LITE CONNECTED!");
                starting = false;
            }

            if (connection === "close") {
                starting = false;

                const code =
                    lastDisconnect?.error?.output?.statusCode;

                if (code !== DisconnectReason.loggedOut) {
                    console.log("Reconnecting...");
                    startBot();
                } else {
                    console.log("Logged out. Login again.");
                }
            }
        });

        sock.ev.on("messages.upsert", async ({ messages }) => {
            for (const msg of messages) {
                const messageId = msg.key?.id;

                try {
                    if (!msg.message) continue;

                    const jid = msg.key.remoteJid;

                    if (!jid || jid === "status@broadcast") continue;

                    if (!config.allowGroups && jid.endsWith("@g.us")) {
                        continue;
                    }

                    if (msg.key.fromMe) {
                        if (!config.selfChat) continue;

                        const ownJid = sock.user?.id?.split(":")[0];
                        const chatJid = jid.split(":")[0];

                        if (ownJid !== chatJid) continue;
                    }

                    if (messageId && processing.has(messageId)) {
                        continue;
                    }

                    const text = getText(msg.message);

                    if (!text || !config.autoReply) continue;

                    if (messageId) processing.add(messageId);

                    console.log("Message:", text);

                    await sock.sendPresenceUpdate("composing", jid);

                    const answer = await generateAI(text);

                    await sock.sendMessage(jid, {
                        text: answer
                    });

                    console.log("AI replied!");

                } catch (error) {
                    console.error("Message Error:", error.message);

                    try {
                        await sock.sendMessage(msg.key.remoteJid, {
                            text: "Sorry! AI එකෙන් පිළිතුරක් ලබාගන්න බැරි වුණා. ටිකකින් නැවත උත්සාහ කරන්න."
                        });
                    } catch (sendError) {
                        console.error("Reply Error:", sendError.message);
                    }

                } finally {
                    if (messageId) processing.delete(messageId);

                    try {
                        await sock.sendPresenceUpdate(
                            "paused",
                            msg.key.remoteJid
                        );
                    } catch {}
                }
            }
        });

    } catch (error) {
        starting = false;
        console.error("Startup Error:", error.message);
    }
}

if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY missing in .env");
    process.exit(1);
}

startBot();
