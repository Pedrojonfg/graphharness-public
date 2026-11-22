import random

import pytest
from fastapi.testclient import TestClient

from app.evaluators.code_comprehension_v1 import (
    CodeComprehensionError,
    client_payload,
    generate,
    grade,
    parse_recipe,
    validate,
    visible_distractors,
)
from app.main import app

PARSONS = {
    "version": 1,
    "kind": "parsons",
    "statement": "Order the lines to print hello.",
    "language": "python",
    "lines": [
        {"key": "l0", "text": 'print("hello")', "indent": 0},
        {"key": "l1", "text": "x = 1", "indent": 0},
        {"key": "d0", "text": "import os", "indent": 0, "distractor": True},
    ],
    "order": ["l0", "l1"],
}

PREDICT = {
    "version": 1,
    "kind": "predict",
    "statement": "What does this program print?",
    "lines": [{"key": "l0", "text": "print(2+2)", "indent": 0}],
    "order": ["l0"],
    "expectedOutput": "4",
    "accepted": ["4.0"],
}

SPOT = {
    "version": 1,
    "kind": "spot_bug",
    "statement": "Which line fails?",
    "lines": [
        {"key": "l0", "text": "a = [1,2,3]", "indent": 0},
        {"key": "l1", "text": "print(a[10])", "indent": 0},
    ],
    "order": ["l0", "l1"],
    "buggyKey": "l1",
}

FADED = {
    "version": 1,
    "kind": "faded_parsons",
    "statement": "Fill in and order.",
    "lines": [
        {"key": "l0", "text": "for i in range(____):", "indent": 0},
        {"key": "l1", "text": "    print(i)", "indent": 4},
    ],
    "order": ["l0", "l1"],
    "blanks": [{"lineKey": "l0", "answer": "3", "accepted": []}],
}


def test_parse_rejects_distractor_in_order():
    bad = {**PARSONS, "order": ["l0", "l1", "d0"]}
    with pytest.raises(CodeComprehensionError):
        parse_recipe(bad)


def test_predict_requires_output():
    with pytest.raises(CodeComprehensionError):
        parse_recipe({**PREDICT, "expectedOutput": ""})


def test_spot_requires_buggy_key():
    with pytest.raises(CodeComprehensionError):
        parse_recipe({**SPOT, "buggyKey": "nope"})


def test_shuffle_is_seeded_and_client_hides_solution():
    recipe = parse_recipe(PARSONS)
    a = generate(recipe, random.Random(7))
    b = generate(recipe, random.Random(7))
    assert [ln["key"] for ln in a["lines"]] == [ln["key"] for ln in b["lines"]]
    assert a["order"] == ["l0", "l1"]
    cp = client_payload(a)
    assert "order" not in cp and "buggyKey" not in cp
    assert cp["statement"] == PARSONS["statement"]


@pytest.mark.parametrize(
    "fail_count,visible",
    [(0, 4), (1, 4), (2, 2), (3, 0), (10, 0)],
)
def test_visible_distractors(fail_count, visible):
    assert visible_distractors(4, fail_count) == visible


def test_grade_kinds():
    inst = generate(parse_recipe(PARSONS), random.Random(1))
    assert grade(inst, {"given": {"order": ["l0", "l1"]}})["correct"] is True
    assert grade(inst, {"given": {"order": ["l1", "l0"]}})["correct"] is False

    inst_p = generate(parse_recipe(PREDICT), random.Random(1))
    assert grade(inst_p, {"given": {"output": "4"}})["correct"] is True
    assert grade(inst_p, {"given": {"output": "4.0"}})["correct"] is True
    assert grade(inst_p, {"given": {"output": "5"}})["correct"] is False

    inst_s = generate(parse_recipe(SPOT), random.Random(1))
    assert grade(inst_s, {"given": {"lineKey": "l1"}})["correct"] is True
    assert grade(inst_s, {"given": {"lineKey": "l0"}})["correct"] is False

    inst_f = generate(parse_recipe(FADED), random.Random(1))
    assert grade(inst_f, {"given": {"order": ["l0", "l1"], "blanks": {"l0": "3"}}})["correct"] is True


def test_validate_ok():
    assert validate(PARSONS, seed=3)["ok"]


def test_http_generate_and_grade():
    client = TestClient(app)
    gen = client.post(
        "/v1/generate",
        json={
            "evaluatorKey": "code_comprehension_v1",
            "generationSpec": {"seed": 2, "recipe": PARSONS},
            "stepId": "s",
        },
    )
    assert gen.status_code == 200
    payload = gen.json()["payload"]
    gr = client.post(
        "/v1/grade",
        json={
            "evaluatorKey": "code_comprehension_v1",
            "payload": payload,
            "stepId": "s",
            "userInput": {"given": {"order": payload["order"]}},
        },
    )
    assert gr.json()["correct"] is True
