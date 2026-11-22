import path from 'node:path';
import { normalizeOverlayLayout } from '../overlay-layout-store.js';


function jsonLayout(value, defaults) {
  // Keep the established JavaScript normalization/coercion contract while
  // crossing the JSON-backed Rust store boundary. This is still one native
  // sidecar + settings transaction; the adapter never writes layout files.
  const normalized = normalizeOverlayLayout(value, defaults);
  return {
    layout: JSON.parse(JSON.stringify(normalized)),
    transientNaNOpacity: Number.isNaN(normalized.background.opacity),
  };
}

/** Product reactions remain in the dispatcher; this adapter owns no files. */
export class NativeOverlayLayoutStore {
  constructor({dir,defaults={},request}={}) {
    if(typeof request!=='function') throw new TypeError('Native layouts require a private request function');
    this.filePath=path.join(dir,'overlay-layouts.json');
    this.defaults=defaults;
    this.request=request;
  }
  _defaults(){const value=typeof this.defaults==='function'?this.defaults():this.defaults;return value===undefined?{}:value;}
  async loadSnapshot(){
    const result=await this.request('overlay-layout-list-snapshot',[]);
    if(!result || !result.data || !result.cache) throw new Error('Native overlay layout snapshot is invalid');
    return result;
  }
  async load(){return (await this.loadSnapshot()).data;}
  mutateAndApply(method,value){
    if(!['save','select','delete','rename'].includes(method)) throw new TypeError('Invalid overlay layout mutation');
    let normalized=value;
    let transientNaNOpacity = false;
    if(method==='save') {
      const result=jsonLayout(value,this._defaults());
      normalized=result.layout;
      transientNaNOpacity=result.transientNaNOpacity;
    }
    else if(method==='select'||method==='delete') normalized=typeof value==='string'?value:null;
    else normalized={
      id:typeof value?.id==='string'?value.id:null,
      name:typeof value?.name==='string'?value.name:null,
    };
    const pending=this.request('overlay-layout-mutate-and-apply',[method,normalized]);
    if(!transientNaNOpacity) return pending;
    const layoutId=normalized.id;
    return Promise.resolve(pending).then((response)=>{
      const layouts=response?.data?.layouts;
      if(!Array.isArray(layouts)) return response;
      let restored=false;
      const result=layouts.map((layout)=>{
        if(layout?.id!==layoutId) return layout;
        restored=true;
        return {...layout,background:{...layout.background,opacity:Number.NaN}};
      });
      return restored?{...response,data:{...response.data,layouts:result}}:response;
    });
  }
}
