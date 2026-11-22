# Ported from graphlearn/apps/eval/tests/test_pattern_hash.py (65b56d6).
from app.pattern_hash import user_input_pattern_hash


def test_pattern_hash_stable_key_order():
    a = {"result": [[1, 2], [3, 4]]}
    b = {"result": [[1, 2], [3, 4]]}
    assert user_input_pattern_hash(a) == user_input_pattern_hash(b)
