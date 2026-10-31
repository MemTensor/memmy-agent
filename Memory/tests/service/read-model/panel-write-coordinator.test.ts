import {describe,it,expect} from "vitest";
import {PanelWriteCoordinator} from "../../../src/service/panel/write-coordinator.js";
describe("panel cache and capture write admission",()=>{
  it("waits outside capture and gives queued captures a turn between worker batches",async()=>{
    const writes=new PanelWriteCoordinator();
    const release=await writes.acquire();
    const events:string[]=[];
    const capture=writes.run(async()=>{events.push("capture");return 1;});
    const next=writes.acquire().then(done=>{events.push("cache");done();});
    await Promise.resolve();expect(events).toEqual([]);
    release();await expect(capture).resolves.toBe(1);await next;
    expect(events).toEqual(["capture","cache"]);
  });
  it("retries the whole rolled-back operation, with a bounded busy budget",async()=>{
    const writes=new PanelWriteCoordinator();let attempts=0;
    await expect(writes.run(async()=>{if(++attempts<3)throw Object.assign(new Error("busy"),{code:"SQLITE_BUSY_SNAPSHOT"});return "saved";})).resolves.toBe("saved");
    expect(attempts).toBe(3);attempts=0;
    await expect(writes.run(async()=>{attempts++;throw Object.assign(new Error("busy"),{code:"SQLITE_BUSY"});})).rejects.toThrow("busy");
    expect(attempts).toBe(4);
  });
  it("cancels queued captures and closes admission without running them",async()=>{
    const writes=new PanelWriteCoordinator(),release=await writes.acquire(),controller=new AbortController();let ran=false;
    const pending=writes.run(async()=>{ran=true;},controller.signal).catch(e=>e);
    controller.abort();expect((await pending).name).toBe("AbortError");
    const stopped=writes.acquire().catch(e=>e);writes.close();release();
    expect((await stopped).name).toBe("AbortError");expect(ran).toBe(false);
  });
});
