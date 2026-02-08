console.log("DIAGNOSTIC START");
const fs = require("fs");
try {
    const cluster = require("cluster");
    const os = require("os");
    fs.appendFileSync("diag.log", `Primary: ${cluster.isPrimary}, Master: ${cluster.isMaster}, CPUs: ${os.cpus().length}\n`);
    console.log("DIAGNOSTIC SUCCESS");
} catch (e) {
    fs.appendFileSync("diag.log", `ERROR: ${e.message}\n`);
    console.log("DIAGNOSTIC ERROR");
}
