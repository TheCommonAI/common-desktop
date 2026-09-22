const fs=require('node:fs'),path=require('node:path');
const {failure}=require('./errors.cjs');
class Credentials{
 constructor(dir,storage){this.file=path.join(dir,'credentials.enc');this.storage=storage;}
 available(){return !!this.storage?.isEncryptionAvailable()&&this.storage.getSelectedStorageBackend?.()!=='basic_text';}
 read(){if(!fs.existsSync(this.file))return {};if(!this.available())throw failure('SECURE_STORAGE_UNAVAILABLE');try{return JSON.parse(this.storage.decryptString(fs.readFileSync(this.file)));}catch(e){throw failure('SECURE_STORAGE_UNAVAILABLE',e);}}
 write(value){if(!this.available())throw failure('SECURE_STORAGE_UNAVAILABLE');fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file+'.tmp',this.storage.encryptString(JSON.stringify(value)),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}
}
module.exports={Credentials};
