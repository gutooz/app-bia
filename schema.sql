-- Execute no Supabase: SQL Editor > New query > Run

create table if not exists tasks (
  id text primary key,
  tit text not null,
  "desc" text default '',
  pri text default 'media',
  due text default '',
  st text default 'af',
  ca text default ''
);

create table if not exists hearings (
  id text primary key,
  date text not null,
  "time" text not null,
  cli text not null,
  notes text default '',
  reminded boolean default false
);

create table if not exists notes (
  id int primary key,
  content text default ''
);
insert into notes (id, content) values (1, '') on conflict (id) do nothing;

create table if not exists tg_config (
  id int primary key,
  token text default '',
  chat_id text default '',
  "offset" bigint default 0
);
insert into tg_config (id, token, chat_id, "offset") values (1, '', '', 0) on conflict (id) do nothing;

-- Desabilita RLS (app local com auth própria)
alter table tasks disable row level security;
alter table hearings disable row level security;
alter table notes disable row level security;
alter table tg_config disable row level security;
