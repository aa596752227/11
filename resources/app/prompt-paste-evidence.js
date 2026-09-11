// The production submit path and the standalone diagnostic use the exact same
// paste-evidence implementation. Keeping one implementation prevents a probe
// that passes in the diagnostic from drifting away from the shipped behavior.
module.exports = require("./tools/prompt-probe/paste-probe.cjs");
