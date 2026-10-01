const path = require('path');
const { data, saveData } = require('../state');
const { CLASS_NAMES, CLASS_SHORT, EMOTE_FILES, EMOTE_GUILD_ID } = require('../constants');

const NUMERIC = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function getClassIndex(emoji) {
    const index = emoji.id ? (data.emoteIds || []).indexOf(emoji.id) : NUMERIC.indexOf(emoji.name);
    return index >= 0 && index < CLASS_NAMES.length ? index : -1;
}

let uploadInFlight;
function ensureClassEmotes(client) {
    if (uploadInFlight) return uploadInFlight;
    uploadInFlight = uploadClassEmotes(client).finally(() => { uploadInFlight = null; });
    return uploadInFlight;
}

async function uploadClassEmotes(client) {
    const guild = await client.guilds.fetch(EMOTE_GUILD_ID);
    const emojis = await guild.emojis.fetch();
    data.emoteIds = data.emoteIds || [];
    for (let i = 0; i < CLASS_NAMES.length; i++) {
        // Preserve IDs and existing reactions; upload only missing emotes.
        let emoji = emojis.get(data.emoteIds[i]);
        const name = `class${CLASS_SHORT[i].toLowerCase()}`;
        if (!emoji) emoji = emojis.find(e => e.name === name);
        if (!emoji) emoji = await guild.emojis.create({
            attachment: path.resolve(__dirname, '../..', EMOTE_FILES[i]), name
        });
        data.emoteIds[i] = emoji.id;
        saveData();
    }
    return data.emoteIds;
}

function selectionContent() {
    const choices = CLASS_NAMES.map((name, i) => {
        const id = data.emoteIds?.[i];
        return `${id ? `<:class${CLASS_SHORT[i].toLowerCase()}:${id}>` : NUMERIC[i]} ${name}`;
    });
    return `React vào biểu tượng để chọn môn phái đang chơi. Lựa chọn mới nhất sẽ thay thế phái cũ.\nMuốn chọn lại biểu tượng đã bấm, hãy bỏ reaction rồi bấm lại. Bỏ reaction của phái hiện tại để hủy chọn.\n\n${choices.join('\n')}`;
}

async function seedClassReactions(message) {
    for (let i = 0; i < CLASS_NAMES.length; i++) {
        await message.react(data.emoteIds?.[i] || NUMERIC[i]);
    }
}

module.exports = { getClassIndex, ensureClassEmotes, selectionContent, seedClassReactions };
