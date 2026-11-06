const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const youtubedl = require('youtube-dl-exec');
const fs = require('fs');
const path = require('path');
const { PornHub } = require('pornhub.js');
const pino = require('pino');

const pornhub = new PornHub();

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📱 පහත QR කෝඩ් එක ඔබේ WhatsApp එකෙන් ස්කෑන් කරන්න:\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log('\n✅ WhatsApp වෙත බොට් සාර්ථකව සම්බන්ධ විය! 🤖 BOT IS READY!\n');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('⚠️ කනෙක්ෂන් එක බිඳ වැුණි. නැවත සම්බන්ධ වෙමින්...');
            
            if (shouldReconnect) {
                setTimeout(startBot, 5000);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages.at(0);
            if (!msg?.message || msg.key.fromMe) return;

            const senderJid = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

            if (!text) return;
            const cleanText = text.trim().toLowerCase();

            console.log(`\n📩 මැසේජ් එකක් ආවා: "${text}" (From: ${senderJid})`);

            // 1. .phub කමාන්ඩ් එක (වීඩියෝ සෙවීම සඳහා)
            if (cleanText.startsWith('.phub ')) {
                const query = text.slice(6).trim();
                if (!query) {
                    await sock.sendMessage(senderJid, { text: '⚠️ සෙවුම් වචනයක් දෙන්න. උදා: `.phub tokyo hot`' });
                    return;
                }

                await sock.sendMessage(senderJid, { text: `🔍 "${query}" සොයමින් පවතී... ටිකක් ඉන්න.` });

                try {
                    const searchResult = await pornhub.searchVideo(query);
                    if (!searchResult?.data?.length) {
                        await sock.sendMessage(senderJid, { text: '❌ ප්‍රතිඵල කිසිවක් හමුවී නැත.' });
                        return;
                    }

                    let responseText = `🎬 *PornHub ප්‍රතිඵල (${query}):*\n\n`;
                    searchResult.data.slice(0, 5).forEach((v, i) => {
                        responseText += `*${i + 1}. ${v.title}*\n🔗 ${v.url}\n\n`;
                    });
                    responseText += `📥 ඩවුන්ලෝඩ් කිරීමට: \`.download [URL]\``;

                    await sock.sendMessage(senderJid, { text: responseText });
                } catch (err) {
                    console.error('PH Error:', err);
                    await sock.sendMessage(senderJid, { text: '❌ සෙවුම් දෝෂයක් සිදු විය.' });
                }
            }

            // 2. .download කමාන්ඩ් එක (වීඩියෝ ඩවුන්ලෝඩ් කර යැවීම සඳහා)
            if (cleanText.startsWith('.download ')) {
                const videoUrl = text.slice(10).trim();
                if (!videoUrl) {
                    await sock.sendMessage(senderJid, { text: '⚠️ නිවැරදි URL එකක් දෙන්න.' });
                    return;
                }

                try {
                    await sock.sendMessage(senderJid, { text: '⬇️ වීඩියෝව ඩවුන්ලෝඩ් වෙමින් පවතී... ටිකක් ඉන්න. ⏳' });

                    const uniqueId = Date.now();
                    const outputFileName = `video_${uniqueId}.mp4`;
                    const outputPath = path.join(__dirname, outputFileName);

                    // yt-dlp හරහා නිශ්චිත පාත් එකට වීඩියෝව ඩවුන්ලෝඩ් කිරීම
                    await youtubedl(videoUrl, {
                        output: outputPath,
                        format: 'best[ext=mp4]/best',
                        noCheckCertificates: true,
                        preferFreeFormats: true,
                    });

                    // ෆයිල් එක ඇත්තටම ඩවුන්ලෝඩ් වී ඇත්දැයි පරීක්ෂා කිරීම
                    if (!fs.existsSync(outputPath)) {
                        await sock.sendMessage(senderJid, { text: '❌ ඩවුන්ලෝඩ් වූ ෆයිල් එක සොයාගත නොහැකි විය.' });
                        return;
                    }

                    // වීඩියෝව WhatsApp වෙත යැවීම
                    await sock.sendMessage(senderJid, {
                        video: { url: outputPath },
                        caption: '✅ මෙන්න ඔබ ඉල්ලූ වීඩියෝව!'
                    });

                    // යැවීමෙන් පසු සර්වර් එකෙන් තාවකාලික ෆයිල් එක ඉවත් කිරීම
                    setTimeout(() => {
                        if (fs.existsSync(outputPath)) {
                            fs.unlinkSync(outputPath);
                            console.log('✅ තාවකාලික වීඩියෝ ෆයිල් එක මකා දමන ලදී!');
                        }
                    }, 5000);

                } catch (dlError) {
                    console.error('DL Error:', dlError);
                    await sock.sendMessage(senderJid, { text: '❌ ඩවුන්ලෝඩ් කිරීමේ දෝෂයක් සිදු විය.' });
                }
            }

        } catch (error) {
            console.error('Main Error:', error);
        }
    });
}

startBot();
