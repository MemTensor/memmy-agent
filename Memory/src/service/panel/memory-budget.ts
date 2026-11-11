import { MemoryServiceError } from "../../utils/error.js";

/** One service-wide budget for browse views and overview/analysis results. */
export class PanelMemoryBudget {
  private entries = new Map<object | string, {bytes:number;evict:()=>void}>();
  constructor(private readonly maximum = 64 * 1024 * 1024) {}
  reserve(key: object | string, bytes: number, evict:()=>void): void {
    if(bytes>this.maximum)throw new MemoryServiceError("conflict","Panel result exceeds memory budget; narrow the filter");
    this.release(key);
    let total=this.bytes();
    for(const [old,entry] of this.entries) {
      if(total+bytes<=this.maximum)break;
      this.entries.delete(old);total-=entry.bytes;entry.evict();
    }
    this.entries.set(key,{bytes,evict});
  }
  touch(key:object|string):void {const entry=this.entries.get(key);if(entry){this.entries.delete(key);this.entries.set(key,entry);}}
  release(key:object|string):void {this.entries.delete(key);}
  bytes():number {let total=0;for(const entry of this.entries.values())total+=entry.bytes;return total;}
}
