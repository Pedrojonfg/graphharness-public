# ADR 108: Parsons / predict / spot_bug without running the student's code.
from __future__ import annotations

import math
import random
import re
import unicodedata
from typing import Any

CODE_COMPREHENSION_EVALUATOR_KEY = "code_comprehension_v1"

KINDS = frozenset({"parsons", "faded_parsons", "predict", "spot_bug"})
KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
MAX_STATEMENT = 1200
MAX_LINE_TEXT = 400
MAX_OUTPUT = 120


class CodeComprehensionError(ValueError):
    pass


def normalize_answer(s: str) -> str:
    """Mirror of packages/core/src/flashcards/grade.ts normalizeAnswer."""
    t = unicodedata.normalize("NFKC", s).lower()
    t = re.sub(r"\s+", "", t)
    t = t.replace("−", "-").replace("–", "-")
    t = t.replace("·", "*").replace("×", "*")
    t = t.replace("**", "^")
    t = re.sub(r",(?=\d)", ".", t)
    t = re.sub(r"[()[\]{}]", "", t)
    return t


def visible_distractors(total_distractors: int, fail_count: int) -> int:
    """Mirror of visibleDistractorCount (ADR 108)."""
    if total_distractors <= 0:
        return 0
    if fail_count < 2:
        return total_distractors
    if fail_count == 2:
        return math.ceil(total_distractors / 2)
    return 0


def _norm_blanks(raw: Any) -> list[dict[str, Any]]:
    if raw is None:
        return []
    if isinstance(raw, dict):
        out: list[dict[str, Any]] = []
        for line_key, answer in raw.items():
            if not isinstance(line_key, str) or not isinstance(answer, str):
                raise CodeComprehensionError("blanks: key and answer must be text")
            out.append({"lineKey": line_key, "answer": answer, "accepted": []})
        return out
    if not isinstance(raw, list):
        raise CodeComprehensionError("blanks must be a list or a map")
    out = []
    for b in raw:
        if not isinstance(b, dict):
            raise CodeComprehensionError("each blank must be an object")
        line_key = b.get("lineKey")
        answer = b.get("answer")
        if not isinstance(line_key, str) or not KEY_RE.match(line_key):
            raise CodeComprehensionError("blank.lineKey invalid")
        if not isinstance(answer, str) or not answer.strip():
            raise CodeComprehensionError("blank.answer is empty")
        accepted = b.get("accepted") or []
        if not isinstance(accepted, list) or not all(isinstance(a, str) for a in accepted):
            raise CodeComprehensionError("blank.accepted must be a list of texts")
        out.append({"lineKey": line_key, "answer": answer, "accepted": list(accepted)})
    return out


def parse_recipe(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise CodeComprehensionError("the recipe must be an object")
    if raw.get("version") != 1:
        raise CodeComprehensionError("version must be 1")
    kind = raw.get("kind")
    if kind not in KINDS:
        raise CodeComprehensionError("invalid kind")
    statement = raw.get("statement")
    if not isinstance(statement, str) or not (10 <= len(statement) <= MAX_STATEMENT):
        raise CodeComprehensionError("statement: text of 10 to 1200 characters")

    lines_raw = raw.get("lines")
    if not isinstance(lines_raw, list) or not lines_raw:
        raise CodeComprehensionError("lines must not be empty")
    lines: list[dict[str, Any]] = []
    keys: set[str] = set()
    distractor_count = 0
    for ln in lines_raw:
        if not isinstance(ln, dict):
            raise CodeComprehensionError("each line must be an object")
        key = ln.get("key")
        text = ln.get("text")
        indent = ln.get("indent", 0)
        if not isinstance(key, str) or not KEY_RE.match(key) or key in keys:
            raise CodeComprehensionError(f"invalid or repeated line key: {key}")
        if not isinstance(text, str) or not (1 <= len(text) <= MAX_LINE_TEXT):
            raise CodeComprehensionError(f"{key}: invalid text")
        if isinstance(indent, bool) or not isinstance(indent, int) or not (0 <= indent <= 8):
            raise CodeComprehensionError(f"{key}: indent 0–8")
        distractor = bool(ln.get("distractor", False))
        if kind == "spot_bug" and distractor:
            raise CodeComprehensionError("spot_bug: no distractor lines")
        if distractor:
            distractor_count += 1
        keys.add(key)
        lines.append({"key": key, "text": text, "indent": indent, **({"distractor": True} if distractor else {})})

    order_raw = raw.get("order")
    if not isinstance(order_raw, list) or not order_raw:
        raise CodeComprehensionError("order must not be empty")
    solution_keys = [k for k in order_raw if isinstance(k, str)]
    if len(solution_keys) != len(order_raw):
        raise CodeComprehensionError("order: only line keys")
    non_distractor = {ln["key"] for ln in lines if not ln.get("distractor")}
    if set(solution_keys) != non_distractor or len(solution_keys) != len(set(solution_keys)):
        raise CodeComprehensionError("order must list exactly the non-distractor lines, once each")

    blanks = _norm_blanks(raw.get("blanks"))
    language = raw.get("language")
    if language is not None and (not isinstance(language, str) or not language.strip()):
        raise CodeComprehensionError("invalid language")

    expected_output: str | None = None
    accepted: list[str] = []
    buggy_key: str | None = None

    if kind in ("parsons", "faded_parsons"):
        if raw.get("expectedOutput"):
            raise CodeComprehensionError(f"{kind}: no expectedOutput")
        if raw.get("buggyKey") is not None:
            raise CodeComprehensionError(f"{kind}: no buggyKey")
        blank_keys = {b["lineKey"] for b in blanks}
        if blank_keys - non_distractor:
            raise CodeComprehensionError("blanks reference keys outside the solution")
        if kind == "faded_parsons" and blanks:
            for b in blanks:
                if "____" not in next(ln["text"] for ln in lines if ln["key"] == b["lineKey"]):
                    raise CodeComprehensionError(f"blank {b['lineKey']}: the line has no ____")
    elif kind == "predict":
        expected_output = raw.get("expectedOutput")
        if not isinstance(expected_output, str) or not expected_output.strip():
            raise CodeComprehensionError("predict: expectedOutput must not be empty")
        if len(expected_output) > MAX_OUTPUT:
            raise CodeComprehensionError(f"expectedOutput maximum {MAX_OUTPUT} characters")
        extra = raw.get("accepted") or []
        if not isinstance(extra, list) or not all(isinstance(a, str) for a in extra):
            raise CodeComprehensionError("accepted must be a list of texts")
        accepted = list(extra)
        if blanks:
            raise CodeComprehensionError("predict: no blanks")
    elif kind == "spot_bug":
        buggy_key = raw.get("buggyKey")
        if not isinstance(buggy_key, str) or buggy_key not in keys:
            raise CodeComprehensionError("spot_bug: buggyKey must be in lines")
        if raw.get("expectedOutput"):
            raise CodeComprehensionError("spot_bug: no expectedOutput")

    return {
        "version": 1,
        "kind": kind,
        "statement": statement,
        **({"language": language.strip()} if isinstance(language, str) else {}),
        "lines": lines,
        "order": solution_keys,
        **({"blanks": blanks} if blanks else {}),
        **({"expectedOutput": expected_output.strip(), "accepted": accepted} if kind == "predict" else {}),
        **({"buggyKey": buggy_key} if kind == "spot_bug" else {}),
        **({"distractorsAdaptive": bool(raw.get("distractorsAdaptive"))} if raw.get("distractorsAdaptive") else {}),
        "_meta": {"distractorCount": distractor_count},
    }


def validate(raw: Any, seed: int = 0) -> dict[str, Any]:
    problems: list[str] = []
    try:
        recipe = parse_recipe(raw)
    except CodeComprehensionError as e:
        return {"ok": False, "problems": [str(e)], "recipe": None}
    try:
        inst = generate(recipe, random.Random(seed))
    except CodeComprehensionError as e:
        problems.append(str(e))
        inst = None
    if inst is not None:
        g = grade(inst, {"given": _canonical_given(inst)})
        if not g.get("correct"):
            problems.append("the canonical solution does not score as correct")
    recipe_out = {k: v for k, v in recipe.items() if k != "_meta"}
    return {"ok": not problems, "problems": problems, "recipe": recipe_out if not problems else None, "sample": inst}


def _canonical_given(payload: dict[str, Any]) -> dict[str, Any]:
    kind = payload["kind"]
    if kind in ("parsons", "faded_parsons"):
        out: dict[str, Any] = {"order": list(payload["order"])}
        if payload.get("blanks"):
            out["blanks"] = {b["lineKey"]: b["answer"] for b in payload["blanks"]}
        return out
    if kind == "predict":
        return {"output": payload["expectedOutput"]}
    return {"lineKey": payload["buggyKey"]}


def _shuffle_lines(lines: list[dict[str, Any]], rng: random.Random) -> list[dict[str, Any]]:
    shuffled = [dict(ln) for ln in lines]
    rng.shuffle(shuffled)
    return shuffled


def generate(recipe: dict[str, Any], rng: random.Random | None = None) -> dict[str, Any]:
    rng = rng or random.Random()
    lines = _shuffle_lines(recipe["lines"], rng)
    payload: dict[str, Any] = {
        "comprehensionVersion": 1,
        "kind": recipe["kind"],
        "statement": recipe["statement"],
        "lines": lines,
    }
    if recipe.get("language"):
        payload["language"] = recipe["language"]
    if recipe.get("distractorsAdaptive"):
        payload["distractorsAdaptive"] = True
        payload["distractorCount"] = recipe.get("_meta", {}).get("distractorCount", 0)
    payload["order"] = list(recipe["order"])
    if recipe.get("blanks"):
        payload["blanks"] = [dict(b) for b in recipe["blanks"]]
    if recipe["kind"] == "predict":
        payload["expectedOutput"] = recipe["expectedOutput"]
        if recipe.get("accepted"):
            payload["accepted"] = list(recipe["accepted"])
    if recipe["kind"] == "spot_bug":
        payload["buggyKey"] = recipe["buggyKey"]
    return payload


def client_payload(full: dict[str, Any]) -> dict[str, Any]:
    """Strips the solution; the Hub sends this to the client."""
    hide = {"order", "expectedOutput", "accepted", "buggyKey", "blanks"}
    out = {k: v for k, v in full.items() if k not in hide}
    return out


def _grade_text(expected: str, accepted: list[str], given: Any) -> bool:
    if not isinstance(given, str) and not isinstance(given, (int, float)):
        return False
    g = normalize_answer(str(given))
    return any(normalize_answer(a) == g for a in [expected, *accepted])


def _grade_order(expected: list[str], given: Any) -> bool:
    if not isinstance(given, list) or len(given) != len(expected):
        return False
    return all(isinstance(x, str) and x == expected[i] for i, x in enumerate(given))


def grade(payload: dict[str, Any], user_input: dict[str, Any]) -> dict[str, Any]:
    if payload.get("comprehensionVersion") != 1:
        raise ValueError("invalid_instance_payload")
    given = user_input.get("given")
    if not isinstance(given, dict):
        return {"correct": False}
    kind = payload["kind"]
    if kind in ("parsons", "faded_parsons"):
        if not _grade_order(payload["order"], given.get("order")):
            return {"correct": False}
        for blank in payload.get("blanks") or []:
            answers = given.get("blanks") or {}
            if not isinstance(answers, dict):
                return {"correct": False}
            ans = answers.get(blank["lineKey"])
            if not _grade_text(blank["answer"], blank.get("accepted") or [], ans):
                return {"correct": False}
        return {"correct": True}
    if kind == "predict":
        ok = _grade_text(
            payload["expectedOutput"],
            payload.get("accepted") or [],
            given.get("output"),
        )
        return {"correct": ok}
    if kind == "spot_bug":
        line_key = given.get("lineKey")
        ok = isinstance(line_key, str) and line_key == payload.get("buggyKey")
        return {"correct": ok}
    return {"correct": False}


class CodeComprehensionEvaluator:
    engine = "code_comprehension"

    def generate(self, generation_spec: dict[str, Any]) -> dict[str, Any]:
        recipe = parse_recipe(generation_spec.get("recipe"))
        seed = int(generation_spec.get("seed") or 0)
        return generate(recipe, random.Random(seed))

    def grade(self, payload: dict[str, Any], user_input: dict[str, Any]) -> dict[str, Any]:
        return grade(payload, user_input)
