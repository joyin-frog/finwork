---
name: docx
description: "每当用户想要创建、读取、编辑或操作 Word 文档（.docx 文件）时，使用此技能。触发条件包括：任何提及 'Word doc'、'word document'、'.docx'，或请求生成具有格式（如目录、标题、页码或信头）的专业文档。当从 .docx 文件中提取或重新组织内容、在文档中插入或替换图片、在 Word 文件中执行查找替换、处理修订或批注，或将内容转换为精美的 Word 文档时，也使用此技能。如果用户要求将 '报告'、'备忘录'、'信函'、'模板' 或类似交付物作为 Word 或 .docx 文件，请使用此技能。不要用于 PDF、电子表格、Google 文档或与文档生成无关的通用编码任务。"
---

# DOCX 创建、编辑和分析

## 概述

.docx 文件是一个包含 XML 文件的 ZIP 压缩包。

## 快速参考

| 任务 | 方法 |
|------|------|
| 读取/分析内容 | `pandoc` 或解压以获取原始 XML |
| 创建新文档 | 使用 `docx-js`——参见下方的"创建新文档" |
| 编辑现有文档 | 解压 → 编辑 XML → 重新打包——参见下方的"编辑现有文档" |

### 将 .doc 转换为 .docx

旧版 `.doc` 文件在编辑前必须先转换：

```bash
python scripts/office/soffice.py --headless --convert-to docx document.doc
```

### 读取内容

```bash
# 带修订的文本提取
pandoc --track-changes=all document.docx -o output.md

# 原始 XML 访问
python scripts/office/unpack.py document.docx unpacked/
```

### 转换为图片

```bash
python scripts/office/soffice.py --headless --convert-to pdf document.docx
pdftoppm -jpeg -r 150 document.pdf page
```

### 接受修订

生成一个已接受所有修订的干净文档（需要 LibreOffice）：

```bash
python scripts/accept_changes.py input.docx output.docx
```

---

## 创建新文档

使用 JavaScript 生成 .docx 文件，然后进行验证。安装：`npm install -g docx`

### 设置
```javascript
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
        Header, Footer, AlignmentType, PageOrientation, LevelFormat, ExternalHyperlink,
        InternalHyperlink, Bookmark, FootnoteReferenceRun, PositionalTab,
        PositionalTabAlignment, PositionalTabRelativeTo, PositionalTabLeader,
        TabStopType, TabStopPosition, Column, SectionType,
        TableOfContents, HeadingLevel, BorderStyle, WidthType, ShadingType,
        VerticalAlign, PageNumber, PageBreak } = require('docx');

const doc = new Document({ sections: [{ children: [/* 内容 */] }] });
Packer.toBuffer(doc).then(buffer => fs.writeFileSync("doc.docx", buffer));
```

### 验证
创建文件后，进行验证。如果验证失败，解压，修复 XML，然后重新打包。
```bash
python scripts/office/validate.py doc.docx
```

### 页面尺寸

```javascript
// 关键：docx-js 默认使用 A4，而非 US Letter
// 始终明确设置页面尺寸以获得一致的结果
sections: [{
  properties: {
    page: {
      size: {
        width: 12240,   // 8.5 英寸（DXA 单位）
        height: 15840   // 11 英寸（DXA 单位）
      },
      margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } // 1 英寸页边距
    }
  },
  children: [/* 内容 */]
}]
```

**常见页面尺寸（DXA 单位，1440 DXA = 1 英寸）：**

| 纸张 | 宽度 | 高度 | 内容宽度（1 英寸页边距） |
|-------|-------|--------|---------------------------|
| US Letter | 12,240 | 15,840 | 9,360 |
| A4（默认） | 11,906 | 16,838 | 9,026 |

**横向布局：** docx-js 内部会交换宽度/高度，因此传入纵向尺寸并让它处理交换：
```javascript
size: {
  width: 12240,   // 将短边作为 width 传入
  height: 15840,  // 将长边作为 height 传入
  orientation: PageOrientation.LANDSCAPE  // docx-js 在 XML 中交换它们
},
// 内容宽度 = 15840 - 左边距 - 右边距（使用长边）
```

### 样式（覆盖内置标题样式）

使用 Arial 作为默认字体（通用支持）。为了可读性，标题保持黑色。

```javascript
const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 24 } } }, // 12pt 默认字号
    paragraphStyles: [
      // 重要：使用精确的 ID 来覆盖内置样式
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 0 } }, // TOC 需要 outlineLevel
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 180, after: 180 }, outlineLevel: 1 } },
    ]
  },
  sections: [{
    children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("标题")] }),
    ]
  }]
});
```

### 列表（绝不使用 Unicode 项目符号）

```javascript
// ❌ 错误做法——绝不手动插入项目符号字符
new Paragraph({ children: [new TextRun("• 项目")] })  // 不好
new Paragraph({ children: [new TextRun("\u2022 项目")] })  // 不好

// ✅ 正确做法——使用带有 LevelFormat.BULLET 的编号配置
const doc = new Document({
  numbering: {
    config: [
      { reference: "bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "numbers",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ]
  },
  sections: [{
    children: [
      new Paragraph({ numbering: { reference: "bullets", level: 0 },
        children: [new TextRun("项目符号项")] }),
      new Paragraph({ numbering: { reference: "numbers", level: 0 },
        children: [new TextRun("编号项")] }),
    ]
  }]
});

// ⚠️ 每个 reference 创建独立的编号序列
// 相同的 reference = 连续编号（1,2,3 然后是 4,5,6）
// 不同的 reference = 重新开始编号（1,2,3 然后是 1,2,3）
```

### 表格

**关键：表格需要双重宽度设置**——既要在表格上设置 `columnWidths`，也要在每个单元格上设置 `width`。缺少任何一项，表格在某些平台上会渲染不正确。

```javascript
// 关键：始终设置表格宽度以确保一致的渲染
// 关键：使用 ShadingType.CLEAR（而非 SOLID）以防止黑色背景
const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };

new Table({
  width: { size: 9360, type: WidthType.DXA }, // 始终使用 DXA（百分比在 Google 文档中会出错）
  columnWidths: [4680, 4680], // 必须与表格宽度总和一致（DXA：1440 = 1 英寸）
  rows: [
    new TableRow({
      children: [
        new TableCell({
          borders,
          width: { size: 4680, type: WidthType.DXA }, // 每个单元格也设置
          shading: { fill: "D5E8F0", type: ShadingType.CLEAR }, // 使用 CLEAR 而非 SOLID
          margins: { top: 80, bottom: 80, left: 120, right: 120 }, // 单元格内边距（内部边距，不添加到宽度中）
          children: [new Paragraph({ children: [new TextRun("单元格")] })]
        })
      ]
    })
  ]
})
```

**表格宽度计算：**

始终使用 `WidthType.DXA`——`WidthType.PERCENTAGE` 在 Google 文档中会出错。

```javascript
// 表格宽度 = columnWidths 的总和 = 内容宽度
// US Letter，1 英寸页边距：12240 - 2880 = 9360 DXA
width: { size: 9360, type: WidthType.DXA },
columnWidths: [7000, 2360]  // 必须与表格宽度总和一致
```

**宽度规则：**
- **始终使用 `WidthType.DXA`**——绝不使用 `WidthType.PERCENTAGE`（与 Google 文档不兼容）
- 表格宽度必须等于 `columnWidths` 的总和
- 单元格 `width` 必须与对应的 `columnWidth` 匹配
- 单元格 `margins` 是内部内边距——它们会减少内容区域，不会增加单元格宽度
- 对于全宽表格：使用内容宽度（页面宽度减去左右页边距）

### 图片

```javascript
// 关键：type 参数是必需的
new Paragraph({
  children: [new ImageRun({
    type: "png", // 必需：png、jpg、jpeg、gif、bmp、svg
    data: fs.readFileSync("image.png"),
    transformation: { width: 200, height: 150 },
    altText: { title: "标题", description: "描述", name: "名称" } // 三者全部必需
  })]
})
```

### 分页符

```javascript
// 关键：PageBreak 必须放在 Paragraph 内部
new Paragraph({ children: [new PageBreak()] })

// 或使用 pageBreakBefore
new Paragraph({ pageBreakBefore: true, children: [new TextRun("新页面")] })
```

### 超链接

```javascript
// 外部链接
new Paragraph({
  children: [new ExternalHyperlink({
    children: [new TextRun({ text: "点击此处", style: "Hyperlink" })],
    link: "https://example.com",
  })]
})

// 内部链接（书签 + 引用）
// 1. 在目标位置创建书签
new Paragraph({ heading: HeadingLevel.HEADING_1, children: [
  new Bookmark({ id: "chapter1", children: [new TextRun("第一章")] }),
]})
// 2. 链接到该书签
new Paragraph({ children: [new InternalHyperlink({
  children: [new TextRun({ text: "参见第一章", style: "Hyperlink" })],
  anchor: "chapter1",
})]})
```

### 脚注

```javascript
const doc = new Document({
  footnotes: {
    1: { children: [new Paragraph("来源：2024 年度报告")] },
    2: { children: [new Paragraph("方法参见附录")] },
  },
  sections: [{
    children: [new Paragraph({
      children: [
        new TextRun("收入增长了 15%"),
        new FootnoteReferenceRun(1),
        new TextRun("（使用调整后指标）"),
        new FootnoteReferenceRun(2),
      ],
    })]
  }]
});
```

### 制表位

```javascript
// 同一行右对齐文本（例如，标题旁的日期）
new Paragraph({
  children: [
    new TextRun("公司名称"),
    new TextRun("\t2025 年 1 月"),
  ],
  tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
})

// 点状前导符（例如，目录样式）
new Paragraph({
  children: [
    new TextRun("引言"),
    new TextRun({ children: [
      new PositionalTab({
        alignment: PositionalTabAlignment.RIGHT,
        relativeTo: PositionalTabRelativeTo.MARGIN,
        leader: PositionalTabLeader.DOT,
      }),
      "3",
    ]}),
  ],
})
```

### 多栏布局

```javascript
// 等宽栏
sections: [{
  properties: {
    column: {
      count: 2,          // 栏数
      space: 720,        // 栏间距（DXA 单位，720 = 0.5 英寸）
      equalWidth: true,
      separate: true,    // 栏之间的竖线
    },
  },
  children: [/* 内容在各栏之间自然流动 */]
}]

// 自定义宽度栏（equalWidth 必须为 false）
sections: [{
  properties: {
    column: {
      equalWidth: false,
      children: [
        new Column({ width: 5400, space: 720 }),
        new Column({ width: 3240 }),
      ],
    },
  },
  children: [/* 内容 */]
}]
```

使用带有 `type: SectionType.NEXT_COLUMN` 的新节来强制分栏。

### 目录

```javascript
// 关键：标题必须仅使用 HeadingLevel——不能使用自定义样式
new TableOfContents("目录", { hyperlink: true, headingStyleRange: "1-3" })
```

### 页眉/页脚

```javascript
sections: [{
  properties: {
    page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } // 1440 = 1 英寸
  },
  headers: {
    default: new Header({ children: [new Paragraph({ children: [new TextRun("页眉")] })] })
  },
  footers: {
    default: new Footer({ children: [new Paragraph({
      children: [new TextRun("第 "), new TextRun({ children: [PageNumber.CURRENT] }), new TextRun(" 页")]
    })] })
  },
  children: [/* 内容 */]
}]
```

### docx-js 的关键规则

- **明确设置页面尺寸**——docx-js 默认使用 A4；对于美国文档，使用 US Letter（12240 x 15840 DXA）
- **横向布局：传入纵向尺寸**——docx-js 内部会交换宽度/高度；将短边作为 `width`，长边作为 `height`，并设置 `orientation: PageOrientation.LANDSCAPE`
- **绝不使用 `\n`**——使用独立的 Paragraph 元素
- **绝不使用 Unicode 项目符号**——使用带有编号配置的 `LevelFormat.BULLET`
- **PageBreak 必须放在 Paragraph 中**——独立使用会生成无效的 XML
- **ImageRun 需要 `type`**——始终指定 png/jpg 等
- **始终使用 DXA 设置表格 `width`**——绝不使用 `WidthType.PERCENTAGE`（在 Google 文档中会出错）
- **表格需要双重宽度设置**——`columnWidths` 数组和单元格 `width`，两者必须匹配
- **表格宽度 = columnWidths 的总和**——对于 DXA，确保它们精确相加
- **始终添加单元格边距**——使用 `margins: { top: 80, bottom: 80, left: 120, right: 120 }` 以获得可读的内边距
- **使用 `ShadingType.CLEAR`**——表格底纹绝不使用 SOLID
- **绝不使用表格作为分隔线/标尺**——单元格有最小高度，会渲染为空框（包括在页眉/页脚中）；应在 Paragraph 上使用 `border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "2E75B6", space: 1 } }`。对于两栏页脚，使用制表位（参见制表位部分），而不是表格
- **目录需要仅使用 HeadingLevel**——标题段落上不能使用自定义样式
- **覆盖内置样式**——使用精确的 ID："Heading1"、"Heading2" 等
- **包含 `outlineLevel`**——目录需要（H1 为 0，H2 为 1 等）

---

## 编辑现有文档

就地改写 `.docx` 可能丢格式、样式或复杂域代码。需要保留版式时，优先解压 XML 后做定点修改，再重新打包并验证。

**按顺序完成全部 3 个步骤。**

### 第 1 步：解压
```bash
python scripts/office/unpack.py document.docx unpacked/
```
提取 XML，格式化，合并相邻的文本运行，并将智能引号转换为 XML 实体（`&#x201C;` 等），使其在编辑后仍能保留。使用 `--merge-runs false` 可跳过文本运行合并。

### 第 2 步：编辑 XML

编辑 `unpacked/word/` 目录中的文件。相关模式参见下方的 XML 参考。

**使用 "Claude" 作为作者名**，用于修订和批注，除非用户明确要求使用其他名称。

**直接使用编辑工具进行字符串替换。不要编写 Python 脚本。** 脚本会引入不必要的复杂性。编辑工具会精确显示正在替换的内容。

**关键：新内容使用智能引号。** 添加包含撇号或引号的文本时，使用 XML 实体生成智能引号：
```xml
<!-- 使用这些实体以获得专业的排版效果 -->
<w:t>Here&#x2019;s a quote: &#x201C;Hello&#x201D;</w:t>
```
| 实体 | 字符 |
|--------|-----------|
| `&#x2018;` | '（左单引号） |
| `&#x2019;` | '（右单引号/撇号） |
| `&#x201C;` | "（左双引号） |
| `&#x201D;` | "（右双引号） |

**添加批注：** 使用 `comment.py` 处理多个 XML 文件中的样板代码（文本必须是预转义的 XML）：
```bash
python scripts/comment.py unpacked/ 0 "Comment text with &amp; and &#x2019;"
python scripts/comment.py unpacked/ 1 "Reply text" --parent 0  # 回复批注 0
python scripts/comment.py unpacked/ 0 "Text" --author "Custom Author"  # 自定义作者名
```
然后在 document.xml 中添加标记（参见 XML 参考中的批注部分）。

### 第 3 步：打包
```bash
python scripts/office/pack.py unpacked/ output.docx --original document.docx
```
使用自动修复进行验证，压缩 XML，并创建 DOCX。使用 `--validate false` 可跳过验证。

**自动修复会处理：**
- `durableId` >= 0x7FFFFFFF（重新生成有效的 ID）
- 含空白字符的 `<w:t>` 上缺少 `xml:space="preserve"`

**自动修复不会处理：**
- 格式错误的 XML、无效的元素嵌套、缺失的关系、模式违规

### 常见陷阱

- **替换整个 `<w:r>` 元素**：添加修订时，将整个 `<w:r>...</w:r>` 块替换为兄弟元素 `<w:del>...<w:ins>...`。不要在文本运行内部注入修订标签。
- **保留 `<w:rPr>` 格式**：将原始文本运行的 `<w:rPr>` 块复制到修订文本运行中，以保留粗体、字号等格式。

---

## XML 参考

### 模式合规性

- **`<w:pPr>` 中的元素顺序**：`<w:pStyle>`、`<w:numPr>`、`<w:spacing>`、`<w:ind>`、`<w:jc>`、`<w:rPr>` 放最后
- **空白字符**：为包含前导/尾随空格的 `<w:t>` 添加 `xml:space="preserve"`
- **RSID**：必须是 8 位十六进制数（例如 `00AB1234`）

### 修订

**插入：**
```xml
<w:ins w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:t>插入的文本</w:t></w:r>
</w:ins>
```

**删除：**
```xml
<w:del w:id="2" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>删除的文本</w:delText></w:r>
</w:del>
```

**在 `<w:del>` 内部**：使用 `<w:delText>` 代替 `<w:t>`，使用 `<w:delInstrText>` 代替 `<w:instrText>`。

**最小化编辑**——只标记有变化的部分：
```xml
<!-- 将 "30 天" 改为 "60 天" -->
<w:r><w:t>期限为 </w:t></w:r>
<w:del w:id="1" w:author="Claude" w:date="...">
  <w:r><w:delText>30</w:delText></w:r>
</w:del>
<w:ins w:id="2" w:author="Claude" w:date="...">
  <w:r><w:t>60</w:t></w:r>
</w:ins>
<w:r><w:t> 天。</w:t></w:r>
```

**删除整个段落/列表项**——当从段落中删除全部内容时，还要将段落标记也标记为删除，使其与下一个段落合并。在 `<w:pPr><w:rPr>` 内部添加 `<w:del/>`：
```xml
<w:p>
  <w:pPr>
    <w:numPr>...</w:numPr>  <!-- 如果有列表编号 -->
    <w:rPr>
      <w:del w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z"/>
    </w:rPr>
  </w:pPr>
  <w:del w:id="2" w:author="Claude" w:date="2025-01-01T00:00:00Z">
    <w:r><w:delText>正在删除的整个段落内容...</w:delText></w:r>
  </w:del>
</w:p>
```
如果没有 `<w:pPr><w:rPr>` 中的 `<w:del/>`，接受更改后会留下一个空段落/列表项。

**拒绝其他作者的插入**——将其删除嵌套在他们的插入内部：
```xml
<w:ins w:author="Jane" w:id="5">
  <w:del w:author="Claude" w:id="10">
    <w:r><w:delText>他们插入的文本</w:delText></w:r>
  </w:del>
</w:ins>
```

**恢复其他作者的删除**——在其删除之后添加插入（不要修改他们的删除）：
```xml
<w:del w:author="Jane" w:id="5">
  <w:r><w:delText>已删除的文本</w:delText></w:r>
</w:del>
<w:ins w:author="Claude" w:id="10">
  <w:r><w:t>已删除的文本</w:t></w:r>
</w:ins>
```

### 批注

运行 `comment.py`（参见第 2 步）后，在 document.xml 中添加标记。对于回复，使用 `--parent` 标志，并将标记嵌套在父批注的标记内部。

**关键：`<w:commentRangeStart>` 和 `<w:commentRangeEnd>` 是 `<w:r>` 的兄弟元素，绝不能放在 `<w:r>` 内部。**

```xml
<!-- 批注标记是 w:p 的直接子元素，绝不能放在 w:r 内部 -->
<w:commentRangeStart w:id="0"/>
<w:del w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>已删除</w:delText></w:r>
</w:del>
<w:r><w:t> 更多文本</w:t></w:r>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>

<!-- 批注 0 中嵌套回复 1 -->
<w:commentRangeStart w:id="0"/>
  <w:commentRangeStart w:id="1"/>
  <w:r><w:t>文本</w:t></w:r>
  <w:commentRangeEnd w:id="1"/>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="1"/></w:r>
```

### 图片

1. 将图片文件添加到 `word/media/`
2. 将关系添加到 `word/_rels/document.xml.rels`：
```xml
<Relationship Id="rId5" Type=".../image" Target="media/image1.png"/>
```
3. 将内容类型添加到 `[Content_Types].xml`：
```xml
<Default Extension="png" ContentType="image/png"/>
```
4. 在 document.xml 中引用：
```xml
<w:drawing>
  <wp:inline>
    <wp:extent cx="914400" cy="914400"/>  <!-- EMU：914400 = 1 英寸 -->
    <a:graphic>
      <a:graphicData uri=".../picture">
        <pic:pic>
          <pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline>
</w:drawing>
```

---

## 依赖项

- **pandoc**：文本提取
- **docx**：`npm install -g docx`（新建文档）
- **LibreOffice**：PDF 转换（通过 `scripts/office/soffice.py` 为沙箱环境自动配置）
- **Poppler**：`pdftoppm` 用于图片生成
