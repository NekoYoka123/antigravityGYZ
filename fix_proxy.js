const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'controllers', 'ProxyController.ts');
const content = fs.readFileSync(filePath, 'utf8');

// Identify the signature of the correct method
const methodSig = 'private static async handleAntigravityRequest(';
const methodStart = content.indexOf(methodSig);

if (methodStart === -1) {
    console.error('Could not find handleAntigravityRequest signature');
    process.exit(1);
}

// Find the start of the garbage
// It should be right after the method closes.
// But since the indentation might vary, let's look for the specific garbage start string
const garbageStartStr = '    const requestedModel = openAIBody.model;\r\n    const isStreaming = openAIBody.stream === true;';
// Try CRLF and LF
let garbageStart = content.indexOf(garbageStartStr);
if (garbageStart === -1) {
    const garbageStartStrLF = '    const requestedModel = openAIBody.model;\n    const isStreaming = openAIBody.stream === true;';
    garbageStart = content.indexOf(garbageStartStrLF);
}

if (garbageStart === -1) {
    console.log('Could not find garbage start. Maybe already fixed?');
    // Let's dump the area around where we think it should be
    // console.log(content.substring(methodStart + 2000, methodStart + 4000));
} else {
    // Find the end of the garbage
    // The next valid method is transformOpenAIToGemini
    const nextMethodSig = 'private static transformOpenAIToGemini';
    const nextMethodStart = content.indexOf(nextMethodSig, garbageStart);

    if (nextMethodStart === -1) {
        console.error('Could not find next method signature');
        process.exit(1);
    }

    console.log(`Found garbage from ${garbageStart} to ${nextMethodStart}`);

    // Check if the garbage is indeed garbage (it shouldn't be inside the valid method)
    // The valid method ends before garbageStart.
    // We can just splice it out.
    // We retain the newline before nextMethodStart if needed.

    // Construct new content
    const newContent = content.substring(0, garbageStart) +
        content.substring(nextMethodStart);

    fs.writeFileSync(filePath, newContent, 'utf8');
    console.log('Fixed ProxyController.ts');
}
