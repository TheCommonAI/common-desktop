const fs=require('node:fs'),{execFileSync}=require('node:child_process');
const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
fs.writeFileSync('src/main/build-info.json',JSON.stringify({commit}));
if(process.argv.includes('--signed')){
 for(const key of ['CSC_LINK','CSC_KEY_PASSWORD','COMMON_PUBLISHER'])if(!process.env[key])throw new Error('Missing signing configuration: '+key);
 if(process.platform==='darwin')for(const key of ['APPLE_ID','APPLE_APP_SPECIFIC_PASSWORD','APPLE_TEAM_ID'])if(!process.env[key])throw new Error('Missing notarisation configuration: '+key);
 if(!['win32','darwin'].includes(process.platform))throw new Error('Unsupported signed release platform');
 const pkg=require('../package.json');pkg.build.publish=[{provider:'github',owner:'TheCommonAI',repo:'common-desktop'}];pkg.build.forceCodeSigning=true;
 if(process.platform==='win32')pkg.build.win.publisherName=[process.env.COMMON_PUBLISHER];
 else {pkg.build.mac.notarize=true;pkg.build.mac.identity=process.env.COMMON_PUBLISHER;}
 fs.writeFileSync('package.json',JSON.stringify(pkg,null,2)+'\n');
 fs.writeFileSync('src/main/release-trust.json',JSON.stringify({signed:true,publisher:process.env.COMMON_PUBLISHER}));
}else fs.writeFileSync('src/main/release-trust.json',JSON.stringify({signed:false}));
