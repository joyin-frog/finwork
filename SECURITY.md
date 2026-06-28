# 安全政策 / Security Policy

> **English summary**: Please report security vulnerabilities via GitHub's private Security Advisory channel (see below). Do **not** open a public issue. Financial data exposure bugs are treated as high severity and prioritized.

---

## 支持版本 / Supported Versions

仅最新发布版获得安全修复。

| Version | Supported |
| ------- | --------- |
| Latest  | ✅ Yes    |
| Older   | ❌ No     |

---

## 报告漏洞 / Reporting a Vulnerability

**首选渠道（推荐）**：通过 GitHub 私密安全通道报告——

1. 进入本仓库 → **Security** 标签页 → **Advisories** → **"Report a vulnerability"**
2. 填写漏洞详情（复现步骤、影响范围、危害估计）
3. 提交后维护者会通过 GitHub 私密通道与你沟通

**请勿**在 public issue 中披露漏洞细节，以免在修复落地前被恶意利用。

**备用联系**：如无法使用 GitHub Advisory，可发邮件至维护者安全邮箱：
`<security contact email — 维护者填>`

---

## 财务数据敏感性 / Financial Data Sensitivity

本项目处理用户的财务数据（报销、薪税、对账、申报等）。以下类别的漏洞视为**高危**，优先处理：

- **数据泄露**：本机存储数据被意外写入网络、日志、临时文件或可被第三方读取的位置。
- **脱敏绕过**：身份证号、银行卡号、个人薪资明细等敏感字段未经脱敏/打码直接进入发往 LLM 端点的上下文。
- **越权取数**：绕过访问控制读取不属于当前用户/公司的财务记录。
- **把敏感字段带出本机**：通过任何渠道（遥测、日志上报、代理等）将未脱敏的财务数据发往外部端点。

发现上述问题请第一时间通过私密渠道告知，我们会优先跟进。

---

## 响应预期 / Response Timeline

我们会尽力在 **3 个工作日**内确认收到报告，并在评估后告知处理计划与预计修复时间线。

感谢所有负责任披露（Responsible Disclosure）的安全研究者。
