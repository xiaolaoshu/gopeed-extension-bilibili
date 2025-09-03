// 导入Bilibili API库（注释掉的为备用导入方式）
// import * as bilibili from 'bilibili-api-ts';
// import { Video } from 'bilibili-api-ts/video.js';
import { Video } from '@renmu/bili-api'; // 使用第三方B站API库

/**
 * 从URL中提取BV号（B站视频的新式ID）
 * @param {string} url - 视频页面URL
 * @returns {string|null} 成功返回BV号，失败返回null
 */
function getBvid(url) {
  // 使用正则匹配 /BV+10位字母数字 的格式
  const match = url.match(/\/(BV\w{10})/);
  return match ? match[1] : null; // 返回匹配结果或null
}

/**
 * 从URL中提取av号（B站视频的旧式ID）
 * @param {string} url - 视频页面URL
 * @returns {string|null} 成功返回av号数字，失败返回null
 */
function getAid(url) {
  // 使用正则匹配 /av+数字 的格式
  const match = url.match(/\/av(\d+)/);
  return match ? match[1] : null; // 返回匹配结果或null
}

// API文档参考：
// https://www.npmjs.com/package/bilibili-api-ts
// https://nemo2011.github.io/bilibili-api/

/**
 * Gopeed解析事件处理 - 当解析下载链接时触发
 * @param {Object} ctx - Gopeed提供的上下文对象
 */
gopeed.events.onResolve(async (ctx) => {
  // 解析请求URL
  const url = new URL(ctx.req.url);
  const videoId = {}; // 存储视频ID对象
  
  // 尝试获取两种格式的视频ID
  const bvid = getBvid(url.pathname); // 从路径获取BV号
  if (bvid) {
    videoId.bvid = bvid; // 存储到对象
  }
  const aid = getAid(url.pathname); // 从路径获取av号
  if (aid) {
    videoId.aid = aid; // 存储到对象
  }
  
  // 如果两种ID都不存在，直接返回（不是B站视频链接）
  if (!bvid && !aid) {
    return;
  }

  // 创建视频实例（传入用户cookie和调试模式）
  const video = new Video({ cookie: gopeed.settings.cookie }, true);
  // 获取视频详细信息
  const info = await video.info(videoId);

  // 检查是否为多P视频（pages数组长度>1）
  const isMultiPart = info.pages.length > 1;
  // 初始化要下载的分P索引（默认下载第1个）
  let parts = [0];
  
  if (isMultiPart) {
    // 从URL参数获取指定分P（?p=参数）
    const p = url.searchParams.get('p');
    if (!p) {
      // 如果未指定分P，下载所有分P
      parts = Array.from({ length: info.pages.length }, (_, i) => i);
    } else {
      // 处理分P范围格式（如 1-3, 2-, -5）
      const arr = p.split('-');
      if (arr.length > 1) {
        // 解析起始和结束位置（缺省值处理）
        let start = parseInt(arr[0]) || 1; // 默认从1开始
        let end = parseInt(arr[1]) || info.pages.length; // 默认到最后
        
        // 确保起始<=结束
        if (start > end) {
          [start, end] = [end, start]; // 交换值
        }
        
        // 生成分P索引数组（从0开始计算）
        parts = Array.from({ length: end - start + 1 }, (_, i) => i + start - 1);
      } else {
        // 单个分P情况（如 p=2）
        parts = [parseInt(p) - 1]; // 转为0基索引
      }
      // 过滤无效索引（超出实际分P范围）
      parts = parts.filter((p) => p >= 0 && p < info.pages.length);
    }
  }

  // 构建下载文件列表（每个分P生成视频+音频两个文件）
  const files = parts.flatMap((p) => {
    // 文件名前缀 = 标题 + (分P标记)
    const namePrefix = `${info.title}${isMultiPart ? `(P${p + 1})` : ''}`;

    /**
     * 构建文件信息对象
     * @param {string} type - 文件类型（'video'或'audio'）
     * @returns {Object} 文件信息对象
     */
    function buildFile(type) {
      // 文件扩展名映射
      const t = { video: 'mp4', audio: 'm4a' };
      return {
        // 完整文件名 = 前缀.类型.扩展名
        name: `${namePrefix}.${type}.${t[type]}`,
        req: {
          url: ctx.req.url, // 原始URL
          extra: {
            header: {
              Referer: `https://www.bilibili.com`, // 必须的防盗链请求头
            },
          },
          // 存储元数据标签
          labels: {
            [gopeed.info.identity]: '1', // 插件标识
            bvid, // 视频BV号
            cid: info.pages[p].cid, // 分P的CID
            p, // 分P索引
            type, // 文件类型
          },
        },
      };
    }

    // 为当前分P生成视频和音频两个下载项
    return [buildFile('video'), buildFile('audio')];
  });

  // 返回给Gopeed的解析结果
  ctx.res = {
    name: info.title, // 主标题
    files: files, // 文件列表
  };
});

/** 
 * 下载开始事件处理
 * @param { import('gopeed').OnStartContext } ctx - Gopeed上下文
 */
gopeed.events.onStart(async (ctx) => {
  // 开始下载前更新真实下载链接
  await updateDownloadUrl(ctx.task);
});

/** 
 * 下载错误事件处理
 * @param { import('gopeed').OnErrorContext } ctx - Gopeed上下文
 */
gopeed.events.onError(async (ctx) => {
  // 出错时尝试更新下载链接
  await updateDownloadUrl(ctx.task);
  // 继续任务（重试）
  ctx.task.continue();
});

/** 
 * 更新真实下载链接
 * @param { import('@gopeed/types').Task } task - Gopeed任务对象
 */
async function updateDownloadUrl(task) {
  const req = task.meta.req;
  // 检查是否需要获取新链接（从未获取过或任务失败）
  if (!req.labels.gotDlink || task.status === 'error') {
    const lables = task.meta.req.labels;
    // 创建视频实例（使用用户cookie）
    const video = new Video({ cookie: gopeed.settings.cookie?.trim() || undefined }, true);
    
    // 设置视频格式选项（位掩码组合）：
    let fnval = 16 | 2048; // DASH格式(16) + AV1编码(2048)
    fnval |= 128;  // 启用4K
    fnval |= 1024; // 启用8K
    // 根据用户设置添加选项
    if (gopeed.settings.hdr) {
      fnval |= 64; // HDR
    }
    if (gopeed.settings.dbs) {
      fnval |= 256; // 杜比视界
      fnval |= 512; // 杜比音效
    }

    // 获取视频播放地址信息
    const videoUrl = await video.playurl({ 
      bvid: lables.bvid, // 视频BV号
      cid: lables.cid,   // 分P的CID
      fnval,             // 格式选项
      fourk: 1           // 4K开关
    });
    
    // 调试日志：打印可用视频流信息
    gopeed.logger.debug('video list', JSON.stringify(videoUrl.dash.video));
    
    // 确定降级策略：优先最高质量(true)还是最低质量(false)
    const fallbackBest = gopeed.settings.qualityFallback === 'best';
    let downloadUrl;
    
    // 处理视频流
    if (lables.type === 'video') {
      // 获取目标质量（标签中存储的或用户设置的默认值）
      const targetQuality = lables.quality || gopeed.settings.quality;
      // 查找匹配质量，找不到则按降级策略排序取第一个
      const matchVideo =
        videoUrl.dash.video.find((item) => item.id == targetQuality) ||
        videoUrl.dash.video.sort((a, b) => (fallbackBest ? b.id - a.id : a.id - b.id))[0];
      req.labels.quality = matchVideo.id; // 记录实际使用的质量
      downloadUrl = matchVideo.baseUrl;  // 获取真实视频地址
    } else {
      // 处理音频流（按质量排序取第一个）
      const matchAudio = videoUrl.dash.audio.sort((a, b) => (fallbackBest ? b.id - a.id : a.id - b.id))[0];
      downloadUrl = matchAudio.baseUrl; // 获取真实音频地址
    }

    // 更新请求信息
    req.url = downloadUrl; // 设置为真实媒体地址
    req.labels.gotDlink = '1'; // 标记已获取下载链接
  }
}