// Atomic file writes: write to a temp sibling then rename over the target.
// rename is atomic on the same filesystem, so a crash mid-write leaves the
// old file intact instead of a truncated one.
const fs = require('fs');
const path = require('path');

function writeAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
}

module.exports = { writeAtomic };
