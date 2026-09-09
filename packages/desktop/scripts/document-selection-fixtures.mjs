import JSZip from "jszip";
import * as XLSX from "xlsx";

export function selectionWorkbook() {
	const book = XLSX.utils.book_new();
	const sheet = { "!ref": "C5:E204", C5: { t: "n", v: 12, f: "SUM(C6:C7)" }, D5: { t: "s", v: "Target" } };
	for (let row = 6; row <= 204; row++) {
		sheet[`C${row}`] = { t: "n", v: row };
		sheet[`D${row}`] = { t: "s", v: `row ${row}` };
	}
	sheet["!merges"] = [{ s: { r: 7, c: 2 }, e: { r: 7, c: 3 } }];
	XLSX.utils.book_append_sheet(book, sheet, "Revenue");
	return Buffer.from(XLSX.write(book, { type: "array", bookType: "xlsx" }));
}

export function selectionPdf() {
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	const content = "BT /F1 20 Tf 50 700 Td (PDF selected sentence.) Tj ET";
	objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
	let result = "%PDF-1.4\n";
	const offsets = [0];
	for (const [i, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(result));
		result += `${i + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = Buffer.byteLength(result);
	result += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
		.slice(1)
		.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
		.join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
	return Buffer.from(result);
}

export async function selectionDeck() {
	const zip = new JSZip();
	const p = "http://schemas.openxmlformats.org/presentationml/2006/main",
		a = "http://schemas.openxmlformats.org/drawingml/2006/main",
		r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
	const rels = (entries) =>
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${r}/${type}" Target="${target}"/>`).join("")}</Relationships>`;
	const emptyTree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
	const namespaces = `xmlns:p="${p}" xmlns:a="${a}" xmlns:r="${r}"`;
	const transform = (x) => `<a:xfrm><a:off x="${x}" y="914400"/><a:ext cx="1828800" cy="914400"/></a:xfrm>`;
	zip.file(
		"[Content_Types].xml",
		'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>',
	);
	zip.file("_rels/.rels", rels([["rId1", "officeDocument", "ppt/presentation.xml"]]));
	zip.file(
		"ppt/presentation.xml",
		`<p:presentation ${namespaces}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="master"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="slide"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
	);
	zip.file(
		"ppt/_rels/presentation.xml.rels",
		rels([
			["slide", "slide", "slides/slide1.xml"],
			["master", "slideMaster", "slideMasters/slideMaster1.xml"],
		]),
	);
	zip.file(
		"ppt/slideMasters/slideMaster1.xml",
		`<p:sldMaster ${namespaces}><p:cSld><p:spTree>${emptyTree}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="layout"/></p:sldLayoutIdLst><p:txStyles/></p:sldMaster>`,
	);
	zip.file(
		"ppt/slideMasters/_rels/slideMaster1.xml.rels",
		rels([
			["layout", "slideLayout", "../slideLayouts/slideLayout1.xml"],
			["theme", "theme", "../theme/theme1.xml"],
		]),
	);
	zip.file(
		"ppt/theme/theme1.xml",
		`<a:theme xmlns:a="${a}" name="Test"><a:themeElements><a:clrScheme name="Test">${["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"].map((n, i) => `<a:${n}><a:srgbClr val="${i === 1 ? "FFFFFF" : "224488"}"/></a:${n}>`).join("")}</a:clrScheme><a:fontScheme name="Test"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Test"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>`,
	);
	zip.file(
		"ppt/slideLayouts/slideLayout1.xml",
		`<p:sldLayout ${namespaces} type="blank"><p:cSld><p:spTree>${emptyTree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
	);
	zip.file(
		"ppt/slideLayouts/_rels/slideLayout1.xml.rels",
		rels([["master", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
	);
	zip.file(
		"ppt/slides/_rels/slide1.xml.rels",
		rels([
			["layout", "slideLayout", "../slideLayouts/slideLayout1.xml"],
			["image", "image", "../media/image1.png"],
			["chart", "chart", "../charts/chart1.xml"],
		]),
	);
	zip.file(
		"ppt/slides/slide1.xml",
		`<p:sld ${namespaces}><p:cSld><p:spTree>${emptyTree}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${transform(457200)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="2000"/><a:t>Selected title</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr id="3" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="image"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${transform(3200400)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="5943600" y="914400"/><a:ext cx="2286000" cy="2286000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="chart"/></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`,
	);
	zip.file(
		"ppt/media/image1.png",
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
			"base64",
		),
	);
	zip.file(
		"ppt/charts/chart1.xml",
		'<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:layout/><c:pieChart><c:ser><c:idx val="0"/><c:order val="0"/><c:cat><c:strLit><c:ptCount val="2"/><c:pt idx="0"><c:v>A</c:v></c:pt><c:pt idx="1"><c:v>B</c:v></c:pt></c:strLit></c:cat><c:val><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>20</c:v></c:pt><c:pt idx="1"><c:v>30</c:v></c:pt></c:numLit></c:val></c:ser></c:pieChart></c:plotArea></c:chart></c:chartSpace>',
	);
	return zip.generateAsync({ type: "nodebuffer" });
}
