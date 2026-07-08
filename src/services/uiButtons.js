// Small discord.js-only UI button helpers shared across the game services.
// currency.js deliberately stays discord.js-free (it returns plain embed
// objects), so the "Kho đồ" button lives here instead.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const log = require('../../logger');

// A fresh "📦 Kho đồ" button. No owner id in the customId — whoever clicks it
// sees THEIR OWN inventory (handled by the `khodo:me` route), so the same
// button works for every viewer of the message.
function khodoButton() {
    return new ButtonBuilder()
        .setCustomId('khodo:me')
        .setLabel('📦 Kho đồ')
        .setStyle(ButtonStyle.Secondary);
}

// Budget-aware append of extra buttons into an existing set of action rows.
// Discord allows at most 5 rows of 5 buttons each. Prefer a new row when there
// is room; otherwise scan existing rows bottom-up for a row with a free slot
// (needed because e.g. the tổng-multi auto resume grid is already 5 rows, so
// the 📦 button has to land in the single-button `[18]` sum row). Buttons that
// can't fit anywhere are dropped with a warning rather than triggering a
// Discord 50035 row-overflow error.
function appendButtons(rows, buttons) {
    for (const btn of buttons) {
        if (rows.length < 5) {
            rows.push(new ActionRowBuilder().addComponents(btn));
            continue;
        }
        let placed = false;
        for (let i = rows.length - 1; i >= 0; i--) {
            if (rows[i].components.length < 5) {
                rows[i].addComponents(btn);
                placed = true;
                break;
            }
        }
        if (!placed) log.warn('uiButtons: no room to append button, dropped');
    }
    return rows;
}

module.exports = { khodoButton, appendButtons };
