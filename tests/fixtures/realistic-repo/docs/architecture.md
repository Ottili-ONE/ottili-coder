# Dependency boundary

```
apps/api -> packages/checkout -> packages/money
```

The money package is pure: no network, filesystem, or application imports.
