const fs = require('fs');
const path = require('path');

const DATA_PATH = path.resolve(__dirname, '..', 'data.json');

const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

function saveData() {
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 0));
}

module.exports = { data, saveData, DATA_PATH };
