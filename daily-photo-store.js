(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.PDLDailyPhotoStore=factory()})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const MAX_FILES=8,MAX_BYTES=6000000;
  class PhotoStore {
    constructor(indexedDB){this.indexedDB=indexedDB;this.pending=new Map()}
    open(){
      if(!this.indexedDB)return Promise.reject(new Error('Photo recovery storage is unavailable'));
      if(!this.database)this.database=new Promise((resolve,reject)=>{
        const request=this.indexedDB.open('pdl-daily-photo-recovery-v1',1);
        request.onupgradeneeded=()=>request.result.createObjectStore('selections',{keyPath:'key'});
        request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();this.database=null};resolve(request.result)};
        request.onerror=()=>{this.database=null;reject(request.error)};
        request.onblocked=()=>{this.database=null;reject(new Error('Close another PDL tab to enable photo recovery'))};
      });
      return this.database;
    }
    async operation(mode,callback){const db=await this.open();return new Promise((resolve,reject)=>{
      const tx=db.transaction('selections',mode),request=callback(tx.objectStore('selections'));
      tx.oncomplete=()=>resolve(request.result);tx.onerror=tx.onabort=()=>reject(tx.error||new Error('Photo recovery could not be saved'));
    })}
    serialize(key,task){const prior=this.pending.get(key)||Promise.resolve(),next=prior.catch(()=>{}).then(task);this.pending.set(key,next);next.finally(()=>{if(this.pending.get(key)===next)this.pending.delete(key)}).catch(()=>{});return next}
    get(key){return this.serialize(key,async()=>((await this.operation('readonly',store=>store.get(key)))?.files||[]))}
    put(key,files){
      if(files.length>MAX_FILES||files.some(row=>row.file.size>MAX_BYTES||!['image/jpeg','image/png','image/webp'].includes(row.file.type)))return Promise.reject(new Error('Choose up to 8 JPEG, PNG, or WebP photos, each 6 MB or smaller'));
      return this.serialize(key,()=>this.operation('readwrite',store=>store.put({key,files,updatedAt:new Date().toISOString()})));
    }
    remove(key){return this.serialize(key,()=>this.operation('readwrite',store=>store.delete(key)))}
  }
  return {PhotoStore,MAX_FILES,MAX_BYTES};
});
