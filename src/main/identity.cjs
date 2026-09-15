// The node identity this machine holds on the Common network.
//
// Shared on purpose with the terminal client (common-network main at 019a5ca):
// `common join` reads and writes ~/.common-network/identity.json, and so does
// this app. One machine is then one node whichever way it joined -- the same
// name, the same node_token -- so `common status` sees a desktop contributor,
// a machine that joined from the terminal can chat from the app without
// registering twice, and a re-join after a crash can still prove it owns its
// name. A private copy here would have made the same computer look like two
// strangers to the gateway.
//
// The file's shape is the terminal's, field for field. Do not reshape it
// without changing join.py's write_identity in the same release.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const IDENTITY_FILE=path.join(os.homedir(),'.common-network','identity.json');
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.replace(/\/$/,'')===b.replace(/\/$/,'');
function read(){try{const v=JSON.parse(fs.readFileSync(IDENTITY_FILE,'utf8'));return v&&typeof v==='object'&&!Array.isArray(v)?v:null;}catch{return null;}}
// Only ever surfaced for the gateway that issued it: --gateway can point this
// app at anyone's server, and a credential that followed the setting would be
// handed to whoever runs it.
function forGateway(gateway){const v=read();return v&&same(v.gateway,gateway)&&typeof v.node_token==='string'&&v.node_token&&typeof v.node_id==='string'?v:null;}
function write(entry){try{fs.mkdirSync(path.dirname(IDENTITY_FILE),{recursive:true});const previous=same(read()?.gateway,entry.gateway)?read():{};const temp=IDENTITY_FILE+'.tmp';fs.writeFileSync(temp,JSON.stringify({...previous,catalogue_id:null,domain_tags:null,...entry,joined_at:Date.now()/1000}),{mode:0o600});fs.renameSync(temp,IDENTITY_FILE);}catch{/* Best effort -- never block joining the network over this. */}}
function clear(gateway){if(!forGateway(gateway))return;try{fs.rmSync(IDENTITY_FILE,{force:true});}catch{}}
module.exports={IDENTITY_FILE,read,forGateway,write,clear};
