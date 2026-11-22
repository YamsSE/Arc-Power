import path from 'node:path';

/** History is owned by the Rust host. This adapter preserves pending-close draining. */
export class NativeStabilityStore {
  constructor({dir,request}={}) {
    if(typeof request!=='function') throw new TypeError('Native stability history requires a private request function');
    this.dir=dir;
    this.filePath=path.join(dir,'stability.json');
    this.request=request;
    this._mutationQueue=Promise.resolve();
  }
  async load(){await this._mutationQueue; return this.request('stability-load',[]);}
  async list(){await this._mutationQueue; return this.request('stability-list',[]);}
  async latest(){await this._mutationQueue; return this.request('stability-latest',[]);}
  append(report){
    const operation=this._mutationQueue.then(()=>this.request('stability-append',[report]));
    this._mutationQueue=operation.catch(()=>{});
    return operation;
  }
}
