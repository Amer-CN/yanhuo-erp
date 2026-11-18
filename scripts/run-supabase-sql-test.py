"""Run the dedicated SQL fixture after validating its loopback URL before connecting."""

from sql_test_guard import main


if __name__ == "__main__":
    raise SystemExit(main())
