import { createServer } from "node:http";
import { closeServer, listen } from "./packaged-app-harness.ts";

function html(title: string, body: string, script = ""): string {
	return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:17px system-ui;margin:24px;color:#20252b;background:#fff}label{display:block;margin:18px 0}input,select,button{font:inherit;padding:8px}iframe{display:block;width:92%;height:480px;border:2px solid #7c8ca0;margin:22px 0}output{display:block;margin:18px 0;padding:12px;background:#edf5ef}h1{font-size:26px}</style></head>
<body>${body}<script>${script}</script></body></html>`;
}

export async function createModelControlsSite() {
	const previews: Array<{ round: string; name: string; course: string; time: string }> = [];
	const requests: string[] = [];
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://fixture.local");
		requests.push(url.pathname);
		response.setHeader("content-type", "text/html; charset=utf-8");
		response.setHeader("cache-control", "no-store");
		if (url.pathname === "/native") {
			response.end(
				html(
					"配送设置",
					`
<h1>配送设置</h1><p>选择配送分组内的服务。库存更新时请按页面提示重新选择。</p>
<label>配送方式 <select id="delivery">
<option value="">请选择</option>
<optgroup label="国内配送"><option value="private-native-domestic">标准配送</option></optgroup>
<optgroup label="国际配送" id="international"><option value="private-native-disabled" disabled>加急配送</option><option value="private-native-initial">标准配送</option></optgroup>
<optgroup label="暂停服务" disabled><option value="private-native-paused">标准配送</option></optgroup>
</select></label>
<label>通知语言 <select id="language"><option>English</option><option>简体中文</option><option disabled>繁體中文</option></select></label>
<p id="notice" role="status">库存已载入</p><button id="preview">预览设置</button><output id="summary"></output>`,
					`
window.controlAudit={changes:[],resetCount:0,previewCount:0};
for(const id of ['delivery','language'])for(const type of ['input','change'])document.getElementById(id).addEventListener(type,event=>{
  window.controlAudit.changes.push({id,type,value:event.target.value,index:event.target.selectedIndex});
});
delivery.addEventListener('change',()=>{
  if(delivery.value==='private-native-initial' && window.controlAudit.resetCount===0){
    window.controlAudit.resetCount++;
    delivery.selectedOptions[0].disabled=true;
    const option=document.createElement('option');option.textContent='标准配送';option.value='private-native-current';international.append(option);
    delivery.selectedIndex=0;
    notice.textContent='库存更新：刚才选择的批次已失效，已重置。国际配送中另有可用的标准配送，请重新选择，再预览。';
  }
});
preview.addEventListener('click',()=>{
  window.controlAudit.previewCount++;
  summary.textContent=delivery.value==='private-native-current'&&language.value==='简体中文'
    ? '预览成功：国际配送 / 标准配送；通知语言：简体中文'
    : '预览未完成：请核对配送方式和通知语言';
});`,
				),
			);
			return;
		}
		if (url.pathname === "/frames") {
			response.end(
				html(
					"报名工作台",
					`
<h1>报名工作台</h1><section aria-label="外层练习表单"><h2>外层练习表单（请勿修改）</h2>
<label>姓名 <input id="outerName" value="外层原值"></label>
<label>课程 <select id="outerCourse"><option>基础课程</option><option>进阶课程</option></select></label>
<button id="outerPreview">预览报名</button><output id="outerSummary">未操作</output></section>
<h2>课程报名嵌入页</h2><iframe title="课程报名入口" src="/frame/hub"></iframe>`,
					`
window.outerAudit={edits:0,clicks:0};document.querySelector('section').addEventListener('input',()=>window.outerAudit.edits++);
outerPreview.addEventListener('click',()=>{window.outerAudit.clicks++;outerSummary.textContent='错误：操作了外层练习表单';});`,
				),
			);
			return;
		}
		if (url.pathname === "/frame/hub") {
			response.end(
				html(
					"课程报名入口",
					'<h1>课程报名入口</h1><p>请在下面的报名表填写信息并预览。</p><iframe title="正式报名表" src="/frame/form?round=1"></iframe>',
				),
			);
			return;
		}
		if (url.pathname === "/frame/form") {
			const round = url.searchParams.get("round") === "2" ? "2" : "1";
			response.end(
				html(
					`正式报名表：第${round}版`,
					`
<h1>正式报名表：第${round}版</h1><p>这是课程报名嵌入页中的正式表单，下面填写姓名、课程和时段。</p>
${round === "2" ? '<button type="button">第 2 版说明</button><p>已重新载入表单，请重新选择课程和时段。</p>' : ""}
<div style="height:780px" aria-hidden="true"></div>
<form action="/frame/preview"><input type="hidden" name="round" value="${round}">
<label>姓名 <input name="name" value="PRIVATE_IFRAME_DRAFT" required></label>
<label>课程 <select name="course"><option value="">请选择</option><option value="basic">基础课程</option><option value="advanced">进阶课程</option><option value="retired" disabled>暂停课程</option></select></label>
<label>时段 <select name="time"><option>上午</option><option>晚间</option></select></label>
<button>预览报名</button></form>`,
				),
			);
			return;
		}
		if (url.pathname === "/frame/preview") {
			const data = {
				round: url.searchParams.get("round") ?? "",
				name: url.searchParams.get("name") ?? "",
				course: url.searchParams.get("course") ?? "",
				time: url.searchParams.get("time") ?? "",
			};
			previews.push(data);
			const escaped = (value: string) =>
				value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
			response.end(
				html(
					"报名预览",
					`<h1>报名预览</h1><output>姓名：${escaped(data.name)}；课程：${data.course === "advanced" ? "进阶课程" : "未选进阶课程"}；时段：${escaped(data.time)}</output><a href="/frame/form?round=2">编辑报名</a>`,
				),
			);
			return;
		}
		response.statusCode = 404;
		response.end("Not found");
	});
	const port = await listen(server);
	return { origin: `http://127.0.0.1:${port}`, previews, requests, close: () => closeServer(server) };
}
