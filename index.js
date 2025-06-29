const express = require('express');
//const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const FormData = require('form-data');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
//app.use(bodyParser.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_SECRET = process.env.APP_SECRET;

const TRANSCRIPTION_SERVICE_URL = process.env.TRANSCRIPTION_SERVICE_URL;
const PORT = process.env.PORT || 3000;

const AUDIO_DIR = path.join(__dirname, 'temp_audio');



const userState = new Map();

const verifyRequestSignature = (req, res, buf) => {
    const signature = req.headers['x-hub-signature-256'];

    if (!signature) {
        throw new Error(`Couldn't find "x-hub-signature-256" in headers.`);
    }
    
    const elements = signature.split('=');
    const signatureHash = elements[1];
    const expectedHash = crypto
        .createHmac('sha256', APP_SECRET)
        .update(buf)
        .digest('hex');
    
    if (signatureHash !== expectedHash) {
        throw new Error('Request signature verification failed');
    }
};


app.use('/webhook', (req, res, next) => {
    if (req.method === 'POST') {
        express.raw({ type: 'application/json' })(req, res, (err) => {
            if (err) {
                return next(err);
            }
            try {
                if (APP_SECRET) {
                    verifyRequestSignature(req, res, req.body);
                }
                req.body = JSON.parse(req.body.toString());
                next();
            } catch (error) {
                console.error('Webhook processing error:', error.message);
                return res.sendStatus(403);
            }
        });
    } else {
        next();
    }
})

/**
 * GET /webhook
 * used by Meta for webhook verification.
 */
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(400);
    }
});

/**
 * POST /webhook
 * endpoint that receives all message notifications from users.
 */
app.post('/webhook', async (req, res) => {
    const messageData = req.body.entry?.[0]?.changes?.[0]?.value;

    if (!messageData) {
        return res.sendStatus(404);
    }

    if (messageData.messages) {
        const message = messageData.messages[0];
        const from = message.from; // User's phone number

        try {
            if (message.type === 'audio') {
                await handleAudioMessage(message, from);
            }
            else if (message.type === 'text') {
                await handleTextMessage(message, from);
            }
        } catch (error) {
            console.error('Failed to process message:', error);
            await sendWhatsAppMessage(from, 'Sorry, something went wrong. Please try again.');
        }
    }
    
    res.sendStatus(200);
});

/**
 * Audio Message Handler
 */
async function handleAudioMessage(message, from) {
    const audioId = message.audio.id;
    console.log(`Received audio message with ID: ${audioId} from ${from}`);

    const mediaUrl = await getMediaUrl(audioId);
    if (!mediaUrl) throw new Error('Could not retrieve media URL.');

    const audioFilePath = await downloadMedia(mediaUrl, audioId);
    if (!audioFilePath) throw new Error('Could not download media.');

    const transcription = await transcribeAudio(audioFilePath);
    console.log(`Transcription result: "${transcription}"`);

    await fs.unlink(audioFilePath);
    
    if (transcription) {
        userState.set(from, { pendingText: transcription });
        const confirmationMessage = `Did you say:\n\n_"${transcription}"_\n\nReply with *Y* to save or *N* to cancel.`;
        await sendWhatsAppMessage(from, confirmationMessage);
    } else {
        await sendWhatsAppMessage(from, "Sorry, I couldn't understand the audio. Please try again.");
    }
}

/**
 * text message handler
 */
async function handleTextMessage(message, from) {
    const text = message.text.body.trim().toUpperCase();

    if (userState.has(from)) {
        const { pendingText } = userState.get(from);
        
        if (text === 'Y') {
            await saveTranscription(from, pendingText);
            await sendWhatsAppMessage(from, "Transcription saved successfully!");
            userState.delete(from);
        } else if (text === 'N') {
            await sendWhatsAppMessage(from, "Ok, I've discarded the transcription.");
            userState.delete(from);
        } else {
            await sendWhatsAppMessage(from, "Please reply with either *Y* (Yes) or *N* (No).");
        }
    } else {
        await sendWhatsAppMessage(from, "Hi there! Send me an audio message, and I'll transcribe it for you.");
    }
}


async function getMediaUrl(mediaId) {
    try {
        const response = await axios.get(`https://graph.facebook.com/v22.0/${mediaId}`, {
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
        });
        return response.data.url;
    } catch (error) {
        console.error('Error getting media URL:', error.response?.data || error.message);
        return null;
    }
}


async function downloadMedia(mediaUrl, audioId) {
    const filePath = path.join(AUDIO_DIR, `${audioId}.ogg`);
    try {
        const response = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
        });
        await fs.writeFile(filePath, response.data);
        console.log(`Successfully downloaded audio to ${filePath}`);
        return filePath;
    } catch (error) {
        console.error('Error downloading media:', error.message);
        return null;
    }
}

/**
 * Polls the transcription service for the result of a job.
 */
async function pollForResult(jobId) {
    const MAX_ATTEMPTS = 20;
    const POLLING_INTERVAL = 3000;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
        try {
            console.log(`Polling for job ${jobId}, attempt ${i + 1}/${MAX_ATTEMPTS}...`);
            const response = await axios.get(`${TRANSCRIPTION_SERVICE_URL}/result/${jobId}`);
            const result = response.data;

            if (result && result.text) {
                console.log(`Success! Result found for job ${jobId}.`);
                return result.text;
            }

            if (result && result.error) {
                console.error(`Polling failed for job ${jobId}:`, result.error);
                return null;
            }
            
            await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL));

        } catch (error) {
            if (error.response && error.response.status === 404) {
                 console.log(`Job ${jobId} not found yet, retrying...`);
            } else {
                console.error(`Error polling for job ${jobId}:`, error.message);
            }
            await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL));
        }
    }

    console.error(`Polling timed out for job ${jobId} after ${MAX_ATTEMPTS} attempts.`);
    return null;
}

/**
 * Sends a file to the custom Python transcription service.
 */
async function transcribeAudio(filePath) {
    if (!TRANSCRIPTION_SERVICE_URL) {
        console.error("TRANSCRIPTION_SERVICE_URL is not set in the environment variables.");
        return null;
    }

    const form = new FormData();
    form.append('file', await fs.readFile(filePath), path.basename(filePath));

    let jobId;
    try {
        const response = await axios.post(`${TRANSCRIPTION_SERVICE_URL}/transcribe/`, form, {
            headers: {
                ...form.getHeaders(),
            }
        });
        
        jobId = response.data.job_id;
        if (!jobId) {
            console.error('Transcription service did not return a job_id.');
            return null;
        }
        console.log(`Transcription job started with ID: ${jobId}`);

    } catch (error) {
        console.error('Error starting transcription job:', error.response?.data || error.message);
        return null;
    }

    return await pollForResult(jobId);
}

/**
 * Sends a text message to a user via the WhatsApp Business API.
 */
async function sendWhatsAppMessage(to, text) {
    try {
        await axios.post(
            `https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: to,
                text: { body: text },
            },
            {
                headers: {
                    'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        console.log(`Message sent to ${to}: "${text}"`);
    } catch (error) {
        console.error('Error sending WhatsApp message:', error.response?.data || error.message);
    }
}

async function saveTranscription(user, text) {
    const logEntry = `${new Date().toISOString()} | User: ${user} | Transcription: "${text}"\n`;
    const dbPath = path.join(__dirname, 'transcriptions.txt');
    try {
        await fs.appendFile(dbPath, logEntry);
        console.log(`Saved transcription to ${dbPath}`);
    } catch (error) {
        console.error('Error saving transcription:', error.message);
    }
}

app.listen(PORT, async () => {
    try {
        await fs.mkdir(AUDIO_DIR, { recursive: true });
    } catch (error) {
        console.error('Error creating temp audio directory:', error);
        process.exit(1);
    }
    
    console.log(`Server is listening on port ${PORT}`);
    console.log('Ensure your webhook URL is set to this server\'s public address in the Meta App Dashboard.');
});