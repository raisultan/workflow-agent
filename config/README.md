# Your deployment's profile

Copy `examples/profile.cordis.patch.yml` here as `profile.cordis.patch.yml` and edit it: Compose mounts this folder into the
container (read-only), and on every start the entry point lays your file over the image's profile. Without it, the image's copy
of the example profile is used, which reads one repository from `.env`.

Files here other than this one are ignored by git, so your profile stays out of the repository.
