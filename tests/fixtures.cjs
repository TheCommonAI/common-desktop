const {randomBytes,createCipheriv,createDecipheriv}=require('node:crypto');
const key=Buffer.alloc(32,7);
const secureStorage={isEncryptionAvailable:()=>true,encryptString(text){const iv=randomBytes(16),cipher=createCipheriv('aes-256-cbc',key,iv);return Buffer.concat([iv,cipher.update(text),cipher.final()]);},decryptString(data){const decipher=createDecipheriv('aes-256-cbc',key,data.subarray(0,16));return Buffer.concat([decipher.update(data.subarray(16)),decipher.final()]).toString();}};
function syntheticNetwork(s){s.modelHealth=async()=>{s.modelHealthy=s.modelKey();};s.probeEndpoint=async()=>{};s.verifyWorker=async()=>{s.workerVerified=true;s.lastVerified=Date.now();};return s;}
module.exports={secureStorage,syntheticNetwork};
