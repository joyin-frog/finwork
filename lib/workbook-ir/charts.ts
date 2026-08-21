import JSZip from "jszip";

export type WorkbookChartInput = {
  type: "bar" | "pie";
  title: string;
  sourceSheet: string;
  categoryRange: string;
  valueRange: string;
  seriesName?: string;
  direction?: "column" | "bar";
  fromCell: string;
  toCell: string;
};

type SheetCharts = { sheetIndex: number; charts: WorkbookChartInput[] };

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DRAWING_REL = `${OFFICE_REL_NS}/drawing`;
const CHART_REL = `${OFFICE_REL_NS}/chart`;
const CELL = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/;
const RANGE = /^\$?([A-Z]{1,3})\$?(\d{1,7}):\$?([A-Z]{1,3})\$?(\d{1,7})$/;

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnIndex(name: string): number {
  return [...name].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);
}

function anchor(cell: string): { column: number; row: number } {
  const hit = CELL.exec(cell.trim().toUpperCase());
  if (!hit) throw new Error(`图表锚点不是有效单元格：${cell}`);
  return { column: columnIndex(hit[1]!) - 1, row: Number(hit[2]) - 1 };
}

function absoluteRange(range: string): string {
  const hit = RANGE.exec(range.trim().toUpperCase());
  if (!hit) throw new Error(`图表数据区域不是有效范围：${range}`);
  return `$${hit[1]}$${hit[2]}:$${hit[3]}$${hit[4]}`;
}

function quotedSheet(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function titleXml(title: string): string {
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="1400"/><a:t>${xml(title)}</a:t></a:r></a:p></c:rich></c:tx><c:layout/><c:overlay val="0"/></c:title>`;
}

function seriesXml(chart: WorkbookChartInput): string {
  const category = `${quotedSheet(chart.sourceSheet)}!${absoluteRange(chart.categoryRange)}`;
  const values = `${quotedSheet(chart.sourceSheet)}!${absoluteRange(chart.valueRange)}`;
  return [
    "<c:ser><c:idx val=\"0\"/><c:order val=\"0\"/>",
    `<c:tx><c:v>${xml(chart.seriesName?.trim() || chart.title)}</c:v></c:tx>`,
    `<c:cat><c:strRef><c:f>${xml(category)}</c:f></c:strRef></c:cat>`,
    `<c:val><c:numRef><c:f>${xml(values)}</c:f></c:numRef></c:val>`,
    "</c:ser>",
  ].join("");
}

function chartXml(chart: WorkbookChartInput, chartNumber: number): string {
  const series = seriesXml(chart);
  const plot = chart.type === "pie"
    ? `<c:pieChart><c:varyColors val="1"/>${series}<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showLeaderLines val="1"/></c:dLbls><c:firstSliceAng val="0"/></c:pieChart>`
    : (() => {
        const categoryAxis = 10_000_000 + chartNumber * 2;
        const valueAxis = categoryAxis + 1;
        const barDirection = chart.direction === "bar" ? "bar" : "col";
        const categoryPosition = chart.direction === "bar" ? "l" : "b";
        const valuePosition = chart.direction === "bar" ? "b" : "l";
        return [
          `<c:barChart><c:barDir val="${barDirection}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="75"/><c:axId val="${categoryAxis}"/><c:axId val="${valueAxis}"/></c:barChart>`,
          `<c:catAx><c:axId val="${categoryAxis}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${categoryPosition}"/><c:tickLblPos val="nextTo"/><c:crossAx val="${valueAxis}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>`,
          `<c:valAx><c:axId val="${valueAxis}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${valuePosition}"/><c:numFmt formatCode="#,##0;[Red](#,##0)" sourceLinked="0"/><c:majorGridlines/><c:tickLblPos val="nextTo"/><c:crossAx val="${categoryAxis}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`,
        ].join("");
      })();
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<c:date1904 val="0"/><c:lang val="zh-CN"/><c:roundedCorners val="0"/><c:style val="10"/>',
    `<c:chart>${titleXml(chart.title)}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}</c:plotArea><c:legend><c:legendPos val="r"/><c:layout/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/><c:showDLblsOverMax val="0"/></c:chart>`,
    '<c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings>',
    "</c:chartSpace>",
  ].join("");
}

function drawingXml(charts: Array<{ input: WorkbookChartInput; relationId: string; chartId: number }>): string {
  const anchors = charts.map(({ input, relationId, chartId }) => {
    const from = anchor(input.fromCell);
    const to = anchor(input.toCell);
    if (to.column <= from.column || to.row <= from.row) {
      throw new Error(`图表 ${input.title} 的 toCell 必须位于 fromCell 右下方`);
    }
    return [
      '<xdr:twoCellAnchor editAs="oneCell">',
      `<xdr:from><xdr:col>${from.column}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${from.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`,
      `<xdr:to><xdr:col>${to.column}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${to.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`,
      `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${chartId}" name="Chart ${chartId}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${relationId}"/></a:graphicData></a:graphic></xdr:graphicFrame>`,
      "<xdr:clientData/></xdr:twoCellAnchor>",
    ].join("");
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors}</xdr:wsDr>`;
}

function relationshipsXml(relations: Array<{ id: string; type: string; target: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_NS}">${relations.map((relation) => `<Relationship Id="${relation.id}" Type="${relation.type}" Target="${relation.target}"/>`).join("")}</Relationships>`;
}

function appendContentType(source: string, partName: string, contentType: string): string {
  if (source.includes(`PartName="${partName}"`)) return source;
  return source.replace("</Types>", `<Override PartName="${partName}" ContentType="${contentType}"/></Types>`);
}

/** Add native OOXML charts to a workbook freshly created by ExcelJS. */
export async function addWorkbookCharts(
  buffer: Buffer,
  sheetCharts: SheetCharts[],
): Promise<Buffer> {
  if (!sheetCharts.some((sheet) => sheet.charts.length > 0)) return buffer;
  const zip = await JSZip.loadAsync(buffer);
  let contentTypes = await zip.file("[Content_Types].xml")!.async("string");
  let chartNumber = 0;
  let drawingNumber = 0;

  for (const { sheetIndex, charts } of sheetCharts) {
    if (!charts.length) continue;
    drawingNumber += 1;
    const sheetPath = `xl/worksheets/sheet${sheetIndex}.xml`;
    const sheetFile = zip.file(sheetPath);
    if (!sheetFile) throw new Error(`找不到图表目标工作表 XML：${sheetPath}`);
    let sheetXml = await sheetFile.async("string");
    if (!sheetXml.includes("xmlns:r=")) {
      sheetXml = sheetXml.replace(
        "<worksheet ",
        `<worksheet xmlns:r="${OFFICE_REL_NS}" `,
      );
    }

    const sheetRelsPath = `xl/worksheets/_rels/sheet${sheetIndex}.xml.rels`;
    const existingRels = zip.file(sheetRelsPath);
    let sheetRels = existingRels
      ? await existingRels.async("string")
      : relationshipsXml([]);
    const relationNumbers = [...sheetRels.matchAll(/Id="rId(\d+)"/g)].map((hit) => Number(hit[1]));
    const drawingRelationId = `rId${Math.max(0, ...relationNumbers) + 1}`;
    sheetRels = sheetRels.replace(
      "</Relationships>",
      `<Relationship Id="${drawingRelationId}" Type="${DRAWING_REL}" Target="../drawings/drawing${drawingNumber}.xml"/></Relationships>`,
    );
    sheetXml = sheetXml.replace("</worksheet>", `<drawing r:id="${drawingRelationId}"/></worksheet>`);

    const drawingCharts: Array<{ input: WorkbookChartInput; relationId: string; chartId: number }> = [];
    const drawingRelations: Array<{ id: string; type: string; target: string }> = [];
    for (const chart of charts) {
      chartNumber += 1;
      const relationId = `rId${drawingCharts.length + 1}`;
      zip.file(`xl/charts/chart${chartNumber}.xml`, chartXml(chart, chartNumber));
      drawingCharts.push({ input: chart, relationId, chartId: chartNumber });
      drawingRelations.push({ id: relationId, type: CHART_REL, target: `../charts/chart${chartNumber}.xml` });
      contentTypes = appendContentType(
        contentTypes,
        `/xl/charts/chart${chartNumber}.xml`,
        "application/vnd.openxmlformats-officedocument.drawingml.chart+xml",
      );
    }

    zip.file(sheetPath, sheetXml);
    zip.file(sheetRelsPath, sheetRels);
    zip.file(`xl/drawings/drawing${drawingNumber}.xml`, drawingXml(drawingCharts));
    zip.file(`xl/drawings/_rels/drawing${drawingNumber}.xml.rels`, relationshipsXml(drawingRelations));
    contentTypes = appendContentType(
      contentTypes,
      `/xl/drawings/drawing${drawingNumber}.xml`,
      "application/vnd.openxmlformats-officedocument.drawing+xml",
    );
  }

  zip.file("[Content_Types].xml", contentTypes);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
