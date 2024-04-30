import mongoose, { Schema, Model } from 'mongoose'

export interface IPost {
  id: Schema.Types.ObjectId;
  user: Schema.Types.ObjectId;
  content: string;
  image: string[];
  timestamp: Date;
  likes : Schema.Types.ObjectId[];
  reposts: Schema.Types.ObjectId[];
}

export interface IUser {
  username: string;
  email: string;
  picture?: string;
  password: string;
  role: 'user' | 'admin';
}

export type PostModel = Model<IPost, {}, {}>;

export const PostSchema = new Schema<IPost>({
  user: {
    type: Schema.Types.ObjectId,
    required: true,
    ref: 'Users'
  },
  content: {
    type: String,
    required: true,
  },
  image: {
    type: [String],
    required: false,
  },
  timestamp: {
    type: Date,
    required: true,
    default: Date.now
  },
  likes: {
    type: [Schema.Types.ObjectId],
    required: false,
    default: []
  },
  reposts: {
    type: [Schema.Types.ObjectId],
    required: false,
    default: []
  }
}
  , {
  methods: {
    like(target: Schema.Types.ObjectId) {
      return this.updateOne({
        $push: {
          likes: target
        }
      })
    },
    unlike(target: Schema.Types.ObjectId) {
      return this.updateOne({
        $pull: {
          likes: target
        }
      })
    },
    repost(target: Schema.Types.ObjectId) {
      return this.updateOne({
        $push: {
          reposts: target
        }
      })
    }
  }
})

export type UserModel = Model<IUser, {}, {}>;

export const UserSchema = new Schema<IUser>({
  username: {
    type: String,
    required: true,
    unique: true
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  picture: {
    type: String,
    required: false
  },
  password: {
    type: String,
    required: true
  },
  role: {
    type: String,
    required: true,
    default: 'user'
  }
})