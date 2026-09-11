const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { assertRunning, currentSignal, runWithSignal } = require("./task-runtime");
const { fetchBoundRecipe } = require("./bound-video-capture");

class NoWatermarkService {
  constructor({ dataRoot, log = () => {}, onChange = () => {} }) {
    this.outputFolder = path.join(path.resolve(dataRoot), "无水印素材");
    this.log = log;this.onChange=onChange;
    this.enabled = false;this.running = false;this.modulePromise = null;
    this.captureJobs = new Map();this.results=new Map();this.pending=new Map();this.controllers=new Map();
  }
  status() {
    return { enabled:this.enabled,running:this.running,folder:this.outputFolder,mode:"verified-task-result-capture",
      activeJobs:this.captureJobs.size,jobs:[...this.results.values()].slice(-100) };
  }
  loadModule() {
    if (!this.modulePromise) {
      process.env.DBNW_PORT="9705";process.env.DBNW_SAVE_DIR=this.outputFolder;process.env.DBNW_HIDE_PAGE_UI="1";
      this.modulePromise=import(pathToFileURL(path.join(__dirname,"no-watermark-daemon.mjs")).href);
    }
    return this.modulePromise;
  }
  async start() {
    this.enabled=true;fs.mkdirSync(this.outputFolder,{recursive:true});
    try {
      const daemon=await this.loadModule();
      daemon.startNoWatermarkDaemon({taskBoundOnly:true});
      this.running=true;
      this.log("无水印素材服务已启动：仅下载已核验任务的视频，不扫描历史",{folder:this.outputFolder});
    }catch(error){this.running=false;this.log("无水印服务启动失败",{error:error.message});throw error;}
    return this.status();
  }
  async stop() {
    this.enabled=false;this.captureJobs.clear();
    for(const abort of this.controllers.values())abort.abort();
    await Promise.allSettled([...this.pending.values()]);
    if(this.modulePromise)await (await this.modulePromise).stopNoWatermarkDaemon();
    this.running=false;return this.status();
  }
  async armCapture(context) {
    if(!this.enabled||!this.running||!context?.jobId||!context.targetId)return false;
    this.captureJobs.set(context.jobId,{...context,armedAt:Date.now()});
    // Registration is immediate. A page-global permission window is never opened.
    this.log("已登记本任务素材下载，等待核验成品编号",{jobId:context.jobId});
    return true;
  }
  async disarmCapture(jobId) {
    const existed=this.captureJobs.delete(String(jobId||""));
    this.onChange(this.status());return existed;
  }
  record(folder,jobId,value) {
    const result={jobId,...value,updatedAt:new Date().toISOString()};
    this.results.set(jobId,result);
    try {
      const file=path.join(folder,"无水印结果.json"),temp=file+".tmp";
      fs.writeFileSync(temp,JSON.stringify(result,null,2));fs.renameSync(temp,file);
    }catch(error){this.log("保存素材下载状态失败",{jobId,error:error.message});}
    this.onChange(this.status());return result;
  }
  async captureResult({client,job,video,folder}) {
    if(!this.enabled||!this.running)return null;
    if(this.pending.has(job.id))return this.pending.get(job.id);
    if(!this.captureJobs.has(job.id))return null;
    if(!video?.messageId||!video.videoId||!video.conversationUrl||!video.captureRecipe){
      this.record(folder,job.id,{state:"unavailable",message:"本任务没有可核验的无水印下载源；普通回填不受影响"});
      return null;
    }
    if(['messageId','videoId','conversationUrl'].some(key=>video[key]!==video.captureRecipe[key])){
      this.record(folder,job.id,{state:'failed',message:'成品编号与下载凭据不一致，未下载任何素材'});return null;
    }
    const parentSignal=currentSignal(),abort=new AbortController();
    this.controllers.set(job.id,abort);
    const signal=parentSignal?AbortSignal.any([parentSignal,abort.signal]):abort.signal;
    const action=runWithSignal(signal,async()=>{
      assertRunning();
      this.record(folder,job.id,{state:"downloading",videoId:video.videoId,message:"正在下载本任务无水印素材"});
      try {
        const recipe=await client.evaluate(fetchBoundRecipe(video.captureRecipe),true,35000);
        assertRunning();
        if(!this.enabled)throw new Error("素材下载开关已关闭");
        if(recipe.videoId!==video.videoId)throw new Error('下载源视频编号不一致');
        const result=await (await this.loadModule()).downloadBoundVideo({...recipe,jobId:job.id,videoId:video.videoId});
        assertRunning();
        this.record(folder,job.id,{state:"completed",videoId:video.videoId,message:"无水印素材已保存并通过 H.264 校验",file:result.savedPath,size:result.size});
        this.log("本任务无水印素材已保存",{jobId:job.id,videoId:video.videoId,file:result.savedPath});
        return result.savedPath;
      }catch(error){
        const stopped=error.code==="DOUBAO_TASK_STOPPED";
        this.record(folder,job.id,{state:stopped?"stopped":"failed",videoId:video.videoId,message:stopped?"素材下载已停止":error.message});
        if(stopped&&!abort.signal.aborted)throw error;
        this.log("本任务素材下载未完成，普通回填继续",{jobId:job.id,error:error.message});
        return null;
      }
    });
    this.pending.set(job.id,action);
    try{return await action;}finally{this.pending.delete(job.id);this.controllers.delete(job.id);}
  }
}
module.exports={NoWatermarkService};
