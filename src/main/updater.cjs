const fs=require('node:fs'),path=require('node:path');
const {failure}=require('./errors.cjs');
function createUpdates(app,service){let trust={};try{trust=JSON.parse(fs.readFileSync(path.join(__dirname,'release-trust.json'),'utf8'));}catch{}
 const enabled=app.isPackaged&&trust.signed===true&&['win32','darwin'].includes(process.platform)&&!!trust.publisher;
 const set=state=>{service.state.update=state;service.emitState();};
 if(!enabled){set({available:false,message:'Automatic updates are blocked until a signed release with a verified publisher is installed.'});return {check:async()=>{},install:async()=>{throw failure('UPDATE_FAILED');},close(){}};}
 const {autoUpdater}=require('electron-updater');autoUpdater.autoDownload=false;autoUpdater.autoInstallOnAppQuit=false;autoUpdater.allowPrerelease=false;autoUpdater.allowDowngrade=false;autoUpdater.logger=null;
 // The feed is compiled into the signed application, never read from settings
 // or supplied over IPC. Keep the library's platform signature verification.
 autoUpdater.setFeedURL({provider:'github',owner:'TheCommonAI',repo:'common-desktop'});
 const fail=e=>{service.record('update_failed',{code:'UPDATE_FAILED'});set({available:false,code:'UPDATE_FAILED',message:'Update check or verification failed. Retry later.'});};autoUpdater.on('error',fail);
 autoUpdater.on('update-available',info=>set({available:true,version:info.version,message:'Common '+info.version+' is available.'}));autoUpdater.on('update-not-available',()=>set({available:false,message:'Common is up to date.'}));
 const verifyConfig=async()=>{if(process.platform==='win32'){const config=await autoUpdater.configOnDisk.value;const names=Array.isArray(config.publisherName)?config.publisherName:[config.publisherName];if(names.length!==1||names[0]!==trust.publisher)throw failure('UPDATE_FAILED');}};
 let checking=false,installing=false;const check=async()=>{if(checking)return;checking=true;try{await verifyConfig();await autoUpdater.checkForUpdates();}catch(e){fail(e);}finally{checking=false;}};
 const timer=setInterval(check,6*3600000);timer.unref();check();
 return {check,async install(){if(installing||!service.state.update?.available)throw failure('UPDATE_FAILED');installing=true;try{await verifyConfig();set({...service.state.update,message:'Downloading and verifying update…'});await autoUpdater.downloadUpdate();await service.close();autoUpdater.quitAndInstall(false,true);}catch(e){fail(e);throw failure('UPDATE_FAILED',e);}finally{installing=false;}},close(){clearInterval(timer);}};
}
module.exports={createUpdates};
