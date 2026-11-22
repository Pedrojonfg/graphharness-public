# UI ↔ MCP / hub_* parity

Every agent tool has at least one path in the PWA that uses the same Hub service (or its REST twin). MCP and LH are not removed.

| MCP / hub_* | REST | PWA |
|-------------|------|-----|
| `resolve_concepts` | `POST /knowledge/resolve` | Search |
| `search_knowledge` | `POST /knowledge/search` | Search |
| `get_concept` | `GET /concepts/:id` | Concept / Map |
| `get_subject_overview` | `GET /subjects/:id/overview` | Map → Overview |
| `get_daily_brief` | `GET /brief` | Today |
| `get_week_plan` | `GET /plan` | Week |
| `declare_learning` | `PATCH /concepts/:id/state` | Concept (change state) |
| `answer_confirmation` | `POST /cards/:id/review` | Cards |
| `add_concept_note` | `POST /concepts/:id/notes` | Concept → Notes |
| `import_class_notes` | `POST /materials/notes` | Materials |
| `import_material` | `POST /materials/import` | Materials |
| `start_session` | `POST /sessions` | Today / Week |
| `close_session` | `POST /sessions/:chatId/close` | Sessions |
| `upsert_exam` | `POST/PATCH /exams` | Exams |
| `list_exams` | `GET /exams` | Exams |
| `get_session_report` | `GET /reports/:id` (+ Sessions list) | Sessions → report |
| `render_pdf` | `POST /reports/:id/render` | Reports |
| `create_subject` | `POST /subjects` | Settings → Subjects |
| `list_concept_suggestions` | `GET /inbox` / suggestions | Inbox |
| `accept_concept_suggestion` | `POST …/accept` | Inbox |
| `dismiss_concept_suggestion` | `POST …/dismiss` | Inbox |
| `get_prior_knowledge` | `GET /prior-reports/:id` | Reports / Prior |
| `import_syllabus` | `PUT /syllabus/:subjectId` | Syllabus |
| `get_syllabus_gaps` | `GET /syllabus/:subjectId/gaps` | Syllabus → gaps |
| `hub_mastery` | `GET /mastery` | Concept → Mastery |
| `hub_errors` | `GET /errors` (+ concept detail) | Concept / Inbox |
| `hub_profile` | `GET /profile` | Settings → Profile |
| `hub_capture` | `POST /capture` | Concept → Capture card |
| `list_lens_feedback` | `GET /lens-feedback` | Concept → Lenses |

**Also in the PWA (REST without a dedicated MCP tool):** merge/split/edges, cards import/retire/queue, exercises, diagnostic, archive subject, list materials.

**Outside product parity:** CLI ops (`rebuild-states`, `rotate-mcp-token`, `export-knowledge`); the exercise dock and native session close in the LH fork.
