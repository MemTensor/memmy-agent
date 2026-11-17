import {MemoryDb} from "../../src/storage/db.js";
import {openPanelCache} from "../../src/storage/panel-cache-db.js";
import {syncPanelCacheBatch,fillPanelCacheBatch,type PanelCachePart} from "../../src/storage/panel-cache.js";
import {sourceVersion} from "../../src/storage/source-changes.js";
export function openCacheFixture(path:string) {
  const source=new MemoryDb({path,readonly:true});
  const cache=openPanelCache(source.db,path);
  return {source,cache,ingest:()=>{const target=sourceVersion(source.db).seq;while(syncPanelCacheBatch(source.db,target)){}},
    prepare(parts:PanelCachePart[]) {this.ingest();for(const part of parts)while(fillPanelCacheBatch(source.db,part,128)){}},
    close:()=>{source.close();cache.close();}};
}
