require('dotenv').config();

const { REST, Routes } = require('discord.js');
const { getAllCommandJSON } = require('./src/commands');
const { APP_ID, DEV_GUILD_ID } = require('./src/constants');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
    console.error('Set BOT_TOKEN env var!');
    process.exit(1);
}

const commands = getAllCommandJSON();
const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
    try {
        console.log('Deleting guild commands...');
        await rest.put(
            Routes.applicationGuildCommands(APP_ID, DEV_GUILD_ID),
            { body: [] }
        );
        console.log('Guild commands deleted.');
    } catch (error) {
        console.error(error);
    }

    try {
        console.log(`Registering ${commands.length} slash commands globally...`);
        await rest.put(
            Routes.applicationCommands(APP_ID),
            { body: commands }
        );
        console.log('Slash commands registered.');
    } catch (error) {
        console.error(error);
    }
})();
